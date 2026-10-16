import { expect } from "bun:test"
import { RequestExecutor } from "@opencode/ai/route"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Voice } from "@opencode/core/voice"
import { Effect, Layer } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const keyCred = (id: string, key: string) =>
  new Credential.Info({
    id: Credential.ID.make(id),
    integrationID: Integration.ID.make("openai"),
    label: id,
    value: Credential.Key.make({ type: "key", key }),
  })

const oauthCred = new Credential.Info({
  id: Credential.ID.make("oauth"),
  integrationID: Integration.ID.make("openai"),
  label: "ChatGPT",
  value: Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("chatgpt"),
    refresh: "rt",
    access: "at_oauth",
    expires: Date.now() + 3600_000,
  }),
})

it.effect("resolves credentials (active key, stored key over OAuth, env fallback, unavailable error)", () =>
  Effect.gen(function* () {
    const auths: string[] = []
    const record = (req: HttpClientRequest.HttpClientRequest) => {
      auths.push(req.headers.authorization ?? "")
      return Response.json({ session: { id: "s1" }, transport: { sdp: "v=0\r\no=answer\r\n" } })
    }
    const call = (model: string, stored: ReadonlyArray<Credential.Info>, onReq = record) =>
      Effect.flatMap(Voice.Service, (voice) =>
        voice.session({
          model,
          transport: model.startsWith("grok-") ? { type: "websocket" } : { type: "webrtc", sdp: "v=0" },
        }),
      ).pipe(
        Effect.provide(
          Voice.layer.pipe(
            Layer.provide(
              Layer.merge(
                Layer.mock(Credential.Service, { list: () => Effect.succeed([...stored]) }),
                RequestExecutor.layer.pipe(
                  Layer.provide(
                    Layer.succeed(
                      HttpClient.HttpClient,
                      HttpClient.make((req) => Effect.sync(() => HttpClientResponse.fromWeb(req, onReq(req)))),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      )

    // Active credential is last in `Credential.list`: active key wins, and OAuth is skipped for stored key.
    yield* call("gpt-live-1", [keyCred("old", "sk-old"), keyCred("active", "sk-active")])
    yield* call("gpt-live-1", [keyCred("stored", "sk-stored"), oauthCred])
    expect(auths).toEqual(["Bearer sk-active", "Bearer sk-stored"])

    const prevOpenAI = process.env.OPENAI_API_KEY
    const prevXAI = process.env.XAI_API_KEY
    delete process.env.OPENAI_API_KEY
    process.env.XAI_API_KEY = "xai-env-key"

    yield* Effect.gen(function* () {
      const oauthOnly = yield* call("gpt-live-1", [oauthCred]).pipe(Effect.flip)
      expect(oauthOnly._tag).toBe("Voice.UnavailableError")
      expect(oauthOnly.message).toContain("OpenAI API key")

      const grok = yield* call("grok-voice-3.0", [], () => Response.json({ value: "ek_xai", expires_at: 1760000999 }))
      expect(grok).toEqual({
        type: "websocket",
        url: "wss://api.x.ai/v1/realtime?model=grok-voice-3.0",
        token: "ek_xai",
        expiresAt: 1760000999,
      })
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY
          if (prevOpenAI !== undefined) process.env.OPENAI_API_KEY = prevOpenAI
          if (prevXAI === undefined) delete process.env.XAI_API_KEY
          if (prevXAI !== undefined) process.env.XAI_API_KEY = prevXAI
        }),
      ),
    )
  }),
)
