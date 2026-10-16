import { expect } from "bun:test"
import { LLMClient, LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Model } from "@opencode/core/model"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionContext } from "@opencode/core/session/context"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Tool } from "@opencode/core/tool"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_agent_model_test")
const agentID = Agent.ID.make("build")
const agentModel = Model.Ref.make({ id: Model.ID.make("agent-model"), providerID: Provider.ID.make("test") })
const sessionModel = Model.Ref.make({ id: Model.ID.make("session-model"), providerID: Provider.ID.make("test") })

/** Mirrors what the catalog default would resolve to, so an unset request is visible rather than inferred. */
const catalogDefault = Model.Ref.make({ id: Model.ID.make("catalog-default"), providerID: Provider.ID.make("test") })

// Every `session.model` the context asks the runner to resolve, in order.
const requested: Array<SessionSchema.Info["model"]> = []

const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) =>
    Effect.sync(() => {
      requested.push(session.model)
      const ref = session.model ?? catalogDefault
      return SessionRunnerModel.resolved(
        LanguageModel.make({ id: ref.id, provider: ref.providerID, route: OpenAIChat.route }),
        {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200_000, output: 32_000 },
        },
      )
    }),
})

const client = Layer.mock(LLMClient.Service)({
  stream: () => Stream.die(new Error("unused")),
  generate: () => Effect.die(new Error("unused")),
})

const builtins = Layer.mock(InstructionBuiltIns.Service, {
  load: () =>
    Effect.succeed(
      Instructions.make({
        key: Instructions.Key.make("test/agent-model"),
        codec: Schema.toCodecJson(Schema.String),
        read: Effect.succeed("Initial context"),
        render: { initial: String, changed: (_previous, current) => current },
      }),
    ),
})

const emptyList = () => Effect.succeed(Instructions.empty)

const discovery = Layer.mock(InstructionDiscovery.Service, { project: true, global: true, load: emptyList })
const skills = Layer.mock(SkillInstructions.Service, { load: emptyList })
const references = Layer.mock(ReferenceInstructions.Service, { load: emptyList })
const mcp = Layer.mock(McpInstructions.Service, { load: emptyList })

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      InstructionBuiltIns.node,
      SessionContext.node,
      PluginHooks.node,
      llmClient,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(client),
      SessionRunnerModel.node.replace(models),
      InstructionBuiltIns.node.replace(builtins),
      InstructionDiscovery.node.replace(discovery),
      SkillInstructions.node.replace(skills),
      ReferenceInstructions.node.replace(references),
      McpInstructions.node.replace(mcp),
      PluginSupervisor.node.replace(Layer.empty),
      Tool.node.replace(
        Layer.mock(Tool.Service, {
          snapshot: () => Effect.succeed({ codeModeCatalog: { tools: [] }, definitions: [] }),
          transform: () => Effect.die(new Error("unused")),
        }),
      ),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

/** A session row with no model of its own — the state `session.create` leaves behind. */
const createSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const projects = yield* Project.Service
  const builtins = yield* InstructionBuiltIns.Service
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
      slug: "agent-model-test",
      directory: "/project",
      title: "Agent model test",
      version: "test",
      agent: agentID,
    })
    .run()
    .pipe(Effect.orDie)
  // The runner prepares this baseline before `load` reads it back.
  yield* InstructionState.prepare(db, bus, yield* builtins.load(), sessionID)
  return db
})

const useAgentModel = (model: SessionSchema.Info["model"]) =>
  Effect.flatMap(Agent.Service, (agents) =>
    agents.transform((editor) => editor.update(agentID, (agent) => void (agent.model = model))),
  )

const resolveFor = Effect.gen(function* () {
  const context = yield* SessionContext.Service
  const selection = yield* context.select(sessionID)
  return yield* context.load(selection)
})

it.effect("resolves the selected agent's configured model for a session that has none", () =>
  Effect.gen(function* () {
    yield* createSession
    yield* useAgentModel(agentModel)
    requested.length = 0

    const loaded = yield* resolveFor

    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({ id: agentModel.id, providerID: agentModel.providerID })
    expect(loaded.model.ref).toMatchObject({ id: agentModel.id, providerID: agentModel.providerID })
  }),
)

it.effect("keeps a session's own model over the agent's configured model", () =>
  Effect.gen(function* () {
    const db = yield* createSession
    yield* useAgentModel(agentModel)
    yield* db.update(SessionTable).set({ model: sessionModel }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
    requested.length = 0

    const loaded = yield* resolveFor

    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({ id: sessionModel.id, providerID: sessionModel.providerID })
    expect(loaded.model.ref).toMatchObject({ id: sessionModel.id, providerID: sessionModel.providerID })
  }),
)

it.effect("falls through to the catalog default when neither is configured", () =>
  Effect.gen(function* () {
    yield* createSession
    yield* useAgentModel(undefined)
    requested.length = 0

    const loaded = yield* resolveFor

    expect(requested).toEqual([undefined])
    expect(loaded.model.ref).toMatchObject({ id: catalogDefault.id, providerID: catalogDefault.providerID })
  }),
)
