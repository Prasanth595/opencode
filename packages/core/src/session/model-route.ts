export * as SessionModelRoute from "./model-route.js"

import { Evaluation, EvaluationClient } from "@opencode/ai/experimental"
import { OpenCode, TypeSafeAI } from "@opencode/ai/providers"
import { Context, Effect, Layer } from "effect"
import { Config } from "../config.js"
import { Bus } from "../bus.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Model } from "../model.js"
import { evaluationClient } from "../effect/app-node-platform.js"
import { SessionEvent } from "./event.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

export const buckets = ["trivial", "local-edit", "multi-file", "architecture"] as const
export type Bucket = (typeof buckets)[number]

export const confidenceThreshold = 0.75
const reasoningThreshold = 0.7
const promptLimit = 8_000
const reasoningVariants = ["max", "xhigh", "high", "thinking"]

export const questions = {
  complexity: {
    type: "choice" as const,
    instructions: "How much coding work does this prompt require?",
    criteria: {
      trivial: "A short question, lookup, or one-line change",
      "local-edit": "A change confined to one file or a small local fix",
      "multi-file": "A change that spans several files or requires coordination",
      architecture: "A design, refactor, or debugging task across the system",
    },
  },
  needs_reasoning: {
    type: "boolean" as const,
    instructions: "Does this prompt need extended reasoning, planning, or careful debugging?",
  },
}

export function isPinned(session: Pick<SessionSchema.Info, "model" | "modelPinned">) {
  if (session.modelPinned !== undefined) return session.modelPinned
  return session.model !== undefined
}

export function sameRef(left: Model.Ref, right: Model.Ref) {
  return (
    left.providerID === right.providerID &&
    left.id === right.id &&
    (left.variant ?? "default") === (right.variant ?? "default")
  )
}

export function shouldRoute(input: {
  session: Pick<SessionSchema.Info, "parentID" | "model" | "modelPinned">
  lastMessageType: string
  enabled: boolean
  hasEvaluation: boolean
}) {
  if (!input.enabled) return false
  if (!input.hasEvaluation) return false
  if (input.session.parentID) return false
  if (input.lastMessageType !== "user") return false
  if (isPinned(input.session)) return false
  return true
}

export function lanes(models: readonly Model.Info[]) {
  const usable = models
    .filter(
      (model) =>
        model.enabled &&
        model.status === "active" &&
        model.capabilities.tools &&
        Model.supportsText(model),
    )
    .toSorted(
      (left, right) =>
        cost(left) - cost(right) || left.id.localeCompare(right.id) || left.providerID.localeCompare(right.providerID),
    )
  const first = usable[0]
  if (!first) return
  const pick = (weight: number) =>
    usable[Math.min(usable.length - 1, Math.round(weight * (usable.length - 1)))] ?? first
  return {
    trivial: pick(0),
    "local-edit": pick(1 / 3),
    "multi-file": pick(2 / 3),
    architecture: pick(1),
  }
}

export function decide(input: {
  complexity: Bucket
  confidence: number
  needsReasoning: number
  catalog: readonly Model.Info[]
  current?: Model.Ref
}) {
  if (input.confidence < confidenceThreshold) return
  const selected = lanes(input.catalog)?.[input.complexity]
  if (!selected) return
  const variant =
    input.needsReasoning >= reasoningThreshold
      ? reasoningVariants.find((id) => selected.variants.some((item) => item.id === id))
      : undefined
  const model = Model.Ref.make({
    id: selected.id,
    providerID: selected.providerID,
    ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
  })
  if (input.current && sameRef(input.current, model)) return
  return { bucket: input.complexity, model, confidence: input.confidence }
}

export function evaluationModel() {
  if (process.env.OPENCODE_API_KEY) return OpenCode.configure().experimental.evaluation("jev-latest")
  if (process.env.TYPESAFE_API_KEY) return TypeSafeAI.configure().experimental.evaluation("jev-latest")
}

export interface Interface {
  readonly consider: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionModelRoute") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const evaluation = yield* EvaluationClient.Service
    const models = yield* Model.Service
    const store = yield* SessionStore.Service
    return Service.of({
      consider: Effect.fn("SessionModelRoute.consider")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return
        const last = (yield* store.context(sessionID).pipe(Effect.orElseSucceed(() => []))).at(-1)
        const enabled = Config.latest(yield* config.entries(), "experimental")?.model_route !== false
        const model = evaluationModel()
        if (
          !shouldRoute({
            session,
            lastMessageType: last?.type ?? "",
            enabled,
            hasEvaluation: model !== undefined,
          }) ||
          !model ||
          last?.type !== "user"
        )
          return
        const catalog = yield* models.available()
        const response = yield* Evaluation.run({
          model,
          state: {
            prompt: last.text.slice(0, promptLimit),
            agent: session.agent ?? null,
          },
          questions,
        }).pipe(
          Effect.timeout("2 seconds"),
          Effect.option,
          Effect.provideService(EvaluationClient.Service, evaluation),
        )
        if (response._tag === "None") return
        const complexity = response.value.answers.complexity
        const needsReasoning = response.value.answers.needs_reasoning
        if (complexity.type !== "choice" || needsReasoning.type !== "boolean") return
        if (!isBucket(complexity.choice)) return
        const decided = decide({
          complexity: complexity.choice,
          confidence: complexity.confidence ?? maxProbability(complexity.probabilities) ?? 1,
          needsReasoning: needsReasoning.probability,
          catalog,
          current: session.model,
        })
        if (!decided) return
        yield* bus.publish(SessionEvent.ModelSelected, {
          sessionID,
          model: decided.model,
          previous: session.model,
          origin: "router",
        })
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Config.node, Model.node, SessionStore.node, evaluationClient],
})

function isBucket(value: string): value is Bucket {
  return buckets.some((bucket) => bucket === value)
}

function cost(model: Model.Info) {
  const entry = model.cost[0]
  if (!entry) return Number.POSITIVE_INFINITY
  return entry.input + entry.output
}

function maxProbability(probabilities: Readonly<Record<string, number>> | undefined) {
  if (!probabilities) return
  return Math.max(...Object.values(probabilities))
}
