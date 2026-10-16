import { expect } from "bun:test"
import { RealtimeClient } from "@opencode/ai/experimental"
import { RequestExecutor } from "@opencode/ai/route"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Voice } from "@opencode/core/voice"
import { Effect, Layer } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

function makeVoiceLayer(options: {
  readonly active?: { readonly type: "credential"; readonly id: Credential.ID; readonly label: string; readonly method: "key" | "oauth" | "external" }
  readonly resolved?: Credential.Value
  readonly stored?: ReadonlyArray<Credential.Info>
  readonly onRequest?: (request: HttpClientRequest.HttpClientRequest) => Response
}) {
  const integrations = Layer.mock(Integration.Service, {
    revision: () => 0,
    connection: {
      active: () => Effect.succeed(options.active),
      resolve: () => Effect.succeed(options.resolved),
      key: () => Effect.die("unused"),
      external: () => Effect.die("unused"),
      activate: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
      status: () => Effect.die("unused"),
    },
    oauth: {
      connect: () => Effect.die("unused"),
      status: () => Effect.die("unused"),
      complete: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
    },
    command: {
      connect: () => Effect.die("unused"),
      status: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
    },
  })
  const credentials = Layer.mock(Credential.Service, {
    list: () => Effect.succeed([...(options.stored ?? [])]),
  })
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() =>
        HttpClientResponse.fromWeb(
          request,
          options.onRequest
            ? options.onRequest(request)
            : Response.json({
                session: { id: "sess_1" },
                transport: { sdp: "v=0\r\no=answer\r\n" },
              }),
        ),
      ),
    ),
  )
  const realtime = RealtimeClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(http))))
  return Voice.layer.pipe(Layer.provide(Layer.mergeAll(integrations, credentials, realtime)))
}

it.effect("uses the active key credential when available", () =>
  Effect.gen(function* () {
    const seen: string[] = []
    const id = Credential.ID.make("crd_active_key")
    const key = Credential.Key.make({ type: "key", key: "sk-active-key" })
    const layer = makeVoiceLayer({
      active: { type: "credential", id, label: "OpenAI Key", method: "key" },
      resolved: key,
      stored: [
        new Credential.Info({
          id,
          integrationID: Integration.ID.make("openai"),
          label: "OpenAI Key",
          value: key,
        }),
      ],
      onRequest: (req) => {
        seen.push(req.headers.authorization ?? "")
        return Response.json({
          session: { id: "sess_1" },
          transport: { sdp: "v=0\r\no=answer\r\n" },
        })
      },
    })

    const transport = yield* Effect.gen(function* () {
      const voice = yield* Voice.Service
      return yield* voice.session({
        model: "gpt-live-1",
        session: { voice: "marin" },
        transport: { type: "webrtc", sdp: "v=0\r\no=offer\r\n", dcid: 4 },
      })
    }).pipe(Effect.provide(layer))

    expect(transport).toEqual({
      type: "webrtc",
      sdp: "v=0\r\no=answer\r\n",
    })
    expect(seen).toEqual(["Bearer sk-active-key"])
  }),
)

it.effect("skips an active ChatGPT OAuth credential and uses a stored API key", () =>
  Effect.gen(function* () {
    const seen: string[] = []
    const oauthID = Credential.ID.make("crd_oauth")
    const keyID = Credential.ID.make("crd_stored_key")
    const oauth = Credential.OAuth.make({
      type: "oauth",
      methodID: Integration.MethodID.make("chatgpt"),
      refresh: "rt_123",
      access: "at_codex_oauth_should_not_be_used",
      expires: Date.now() + 3600_000,
    })
    const storedKey = Credential.Key.make({ type: "key", key: "sk-stored-fallback" })
    const layer = makeVoiceLayer({
      active: { type: "credential", id: oauthID, label: "ChatGPT Plus", method: "oauth" },
      resolved: oauth,
      // Credential.list returns active-last, so stored key is first and active OAuth is last.
      stored: [
        new Credential.Info({
          id: keyID,
          integrationID: Integration.ID.make("openai"),
          label: "API Key",
          value: storedKey,
        }),
        new Credential.Info({
          id: oauthID,
          integrationID: Integration.ID.make("openai"),
          label: "ChatGPT Plus",
          value: oauth,
        }),
      ],
      onRequest: (req) => {
        seen.push(req.headers.authorization ?? "")
        return Response.json({
          session: { id: "sess_2" },
          transport: { sdp: "v=0\r\no=answer\r\n" },
        })
      },
    })

    const transport = yield* Effect.gen(function* () {
      const voice = yield* Voice.Service
      return yield* voice.session({
        model: "gpt-live-1",
        transport: { type: "webrtc", sdp: "v=0\r\no=offer\r\n" },
      })
    }).pipe(Effect.provide(layer))

    expect(transport).toEqual({
      type: "webrtc",
      sdp: "v=0\r\no=answer\r\n",
    })
    expect(seen).toEqual(["Bearer sk-stored-fallback"])
  }),
)

it.effect("fails with UnavailableError when only ChatGPT OAuth is present and no API key exists", () =>
  Effect.gen(function* () {
    const previous = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    const oauthID = Credential.ID.make("crd_oauth_only")
    const oauth = Credential.OAuth.make({
      type: "oauth",
      methodID: Integration.MethodID.make("chatgpt"),
      refresh: "rt_123",
      access: "at_codex_oauth",
      expires: Date.now() + 3600_000,
    })
    const layer = makeVoiceLayer({
      active: { type: "credential", id: oauthID, label: "ChatGPT Plus", method: "oauth" },
      resolved: oauth,
      stored: [
        new Credential.Info({
          id: oauthID,
          integrationID: Integration.ID.make("openai"),
          label: "ChatGPT Plus",
          value: oauth,
        }),
      ],
    })

    const error = yield* Effect.gen(function* () {
      const voice = yield* Voice.Service
      return yield* voice.session({
        model: "gpt-live-1",
        transport: { type: "webrtc", sdp: "v=0\r\no=offer\r\n" },
      })
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENAI_API_KEY
          if (previous !== undefined) process.env.OPENAI_API_KEY = previous
        }),
      ),
      Effect.flip,
    )

    expect(error._tag).toBe("Voice.UnavailableError")
    expect(error.message).toContain("OpenAI API key")
  }),
)

it.effect("falls back to environment API keys and routes Grok Voice to xAI", () =>
  Effect.gen(function* () {
    const previous = process.env.XAI_API_KEY
    process.env.XAI_API_KEY = "xai-env-key"
    const seen: { url: string; auth: string }[] = []
    const layer = makeVoiceLayer({
      onRequest: (req) => {
        seen.push({ url: req.url, auth: req.headers.authorization ?? "" })
        return Response.json({
          value: "ek_xai_token",
          expires_at: 1760000999,
        })
      },
    })

    const transport = yield* Effect.gen(function* () {
      const voice = yield* Voice.Service
      return yield* voice.session({
        model: "grok-voice-3.0",
        transport: { type: "websocket" },
      })
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env.XAI_API_KEY
          if (previous !== undefined) process.env.XAI_API_KEY = previous
        }),
      ),
    )

    expect(transport).toEqual({
      type: "websocket",
      url: "wss://api.x.ai/v1/realtime?model=grok-voice-3.0",
      token: "ek_xai_token",
      expiresAt: 1760000999,
    })
    expect(seen).toEqual([
      {
        url: "https://api.x.ai/v1/realtime/client_secrets",
        auth: "Bearer xai-env-key",
      },
    ])
  }),
)

it.effect("rejects unknown models and unsupported transports with InvalidRequestError", () =>
  Effect.gen(function* () {
    const key = Credential.Key.make({ type: "key", key: "sk-test" })
    const id = Credential.ID.make("crd_key")
    const layer = makeVoiceLayer({
      active: { type: "credential", id, label: "Key", method: "key" },
      resolved: key,
    })

    const unknownModel = yield* Effect.gen(function* () {
      const voice = yield* Voice.Service
      return yield* voice.session({
        model: "unknown-voice-model",
        transport: { type: "websocket" },
      })
    }).pipe(Effect.provide(layer), Effect.flip)

    expect(unknownModel._tag).toBe("Voice.InvalidRequestError")

    const unsupportedTransport = yield* Effect.gen(function* () {
      const voice = yield* Voice.Service
      return yield* voice.session({
        model: "gpt-live-1",
        transport: { type: "websocket" },
      })
    }).pipe(Effect.provide(layer), Effect.flip)

    expect(unsupportedTransport._tag).toBe("Voice.InvalidRequestError")
  }),
)
