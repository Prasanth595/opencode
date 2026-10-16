export * as Voice from "./voice.js"

import { type AIError } from "@opencode/ai"
import {
  OpenAILive,
  OpenAIRealtime,
  Realtime,
  RealtimeClient,
  XAIRealtime,
  type RealtimeSession,
  type RealtimeTransport,
  type RealtimeTransportInput,
} from "@opencode/ai/experimental"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Credential } from "./credential.js"
import { realtimeClient } from "./effect/app-node-platform.js"
import { Integration } from "./integration.js"

export interface SessionInput {
  readonly model: string
  readonly session?: RealtimeSession
  readonly transport: RealtimeTransportInput
}

export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()("Voice.InvalidRequestError", {
  message: Schema.String,
}) {}

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Voice.UnavailableError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
}) {}

export type Error = InvalidRequestError | UnavailableError

export interface Interface {
  readonly session: (input: SessionInput) => Effect.Effect<RealtimeTransport, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Voice") {}

function resolveEngine(model: string) {
  if (model.startsWith("gpt-live-")) {
    return {
      integrationID: Integration.ID.make("openai"),
      env: "OPENAI_API_KEY",
      model: (apiKey: string) => OpenAILive.model({ id: model, apiKey }),
    }
  }
  if (model.startsWith("gpt-realtime-")) {
    return {
      integrationID: Integration.ID.make("openai"),
      env: "OPENAI_API_KEY",
      model: (apiKey: string) => OpenAIRealtime.model({ id: model, apiKey }),
    }
  }
  if (model.startsWith("grok-voice-")) {
    return {
      integrationID: Integration.ID.make("xai"),
      env: "XAI_API_KEY",
      model: (apiKey: string) => XAIRealtime.model({ id: model, apiKey }),
    }
  }
  return undefined
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const realtime = yield* RealtimeClient.Service
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service

    const resolveApiKey = Effect.fn("Voice.resolveApiKey")(function* (
      integrationID: Integration.ID,
      envVar: string,
    ) {
      const active = yield* integrations.connection.active(integrationID)
      if (active && (active.type === "env" || active.method === "key")) {
        const resolved = yield* integrations.connection
          .resolve(active)
          .pipe(Effect.catchTag("Integration.Authorization", () => Effect.undefined))
        if (resolved?.type === "key" && resolved.key) return resolved.key
      }
      const saved = (yield* credentials.list(integrationID)).toReversed()
      const storedKey = saved.find(
        (item): item is Credential.Info & { readonly value: Credential.Key } =>
          item.value.type === "key" && Boolean(item.value.key),
      )
      if (storedKey) return storedKey.value.key
      const envKey = process.env[envVar]
      if (envKey) return envKey
      const hasOAuth =
        (active?.type === "credential" && active.method === "oauth") ||
        saved.some((item) => item.value.type === "oauth")
      return yield* new UnavailableError({
        service: integrationID,
        message:
          integrationID === "openai" && hasOAuth
            ? "OpenAI voice requires an OpenAI API key; ChatGPT/Codex OAuth credentials cannot be used for voice sessions"
            : `${integrationID === "openai" ? "OpenAI" : "xAI"} API key is required for voice sessions`,
      })
    })

    const session = Effect.fn("Voice.session")(function* (input: SessionInput) {
      const engine = resolveEngine(input.model)
      if (!engine) {
        return yield* new InvalidRequestError({
          message: `Unsupported voice model: ${input.model}`,
        })
      }
      const apiKey = yield* resolveApiKey(engine.integrationID, engine.env)
      const response = yield* realtime
        .connect(
          Realtime.request({
            model: engine.model(apiKey),
            session: input.session,
            transport: input.transport,
          }),
        )
        .pipe(
          Effect.mapError((error: AIError): Error =>
            error.reason._tag === "InvalidRequest" || error.reason._tag === "UnsupportedOperation"
              ? new InvalidRequestError({ message: error.message })
              : new UnavailableError({ message: error.message, service: engine.integrationID }),
          ),
        )
      return response.transport
    })

    return Service.of({ session })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, Credential.node, realtimeClient],
})
