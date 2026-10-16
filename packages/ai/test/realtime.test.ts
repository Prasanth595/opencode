import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientRequest } from "effect/http"
import { OpenAILive, OpenAIRealtime, Realtime, RealtimeClient, XAIRealtime } from "../src/experimental.js"
import { it } from "./lib/effect.js"
import { dynamicResponse } from "./lib/http.js"

describe("experimental Realtime", () => {
  it.effect("creates an OpenAI GPT-Live WebRTC session", () =>
    Effect.gen(function* () {
      const response = yield* Realtime.connect({
        model: OpenAILive.model({
          id: "gpt-live-1",
          apiKey: "test-openai-key",
          baseURL: "https://openai.test/v1/",
        }),
        session: {
          instructions: "Be concise.",
          voice: "marin",
          delegation: { type: "responses", responses: { model: "gpt-5.4" } },
        },
        transport: {
          type: "webrtc",
          sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n",
          dcid: 4,
        },
      })

      expect(response.model).toBe("gpt-live-1")
      expect(response.transport).toEqual({
        type: "webrtc",
        sdp: "v=0\r\no=openai 1 1 IN IP4 127.0.0.1\r\n",
      })
      expect(response.providerMetadata).toEqual({
        openai: { sessionId: "sess_live_123" },
      })
    }).pipe(
      Effect.provide(
        RealtimeClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                expect(request.url).toBe("https://openai.test/v1/live/sessions")
                expect(request.headers.get("authorization")).toBe("Bearer test-openai-key")
                expect(request.headers.get("content-type")).toBe("application/json")
                expect(JSON.parse(input.text)).toEqual({
                  session: {
                    instructions: "Be concise.",
                    voice: "marin",
                    delegation: { type: "responses", responses: { model: "gpt-5.4" } },
                    model: "gpt-live-1",
                  },
                  transport: {
                    type: "webrtc",
                    sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n",
                    dcid: 4,
                  },
                })
                return input.respond(
                  JSON.stringify({
                    session: { id: "sess_live_123" },
                    transport: { sdp: "v=0\r\no=openai 1 1 IN IP4 127.0.0.1\r\n" },
                  }),
                  { headers: { "content-type": "application/json" } },
                )
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("rejects WebSocket transport on OpenAI GPT-Live", () =>
    Effect.gen(function* () {
      const error = yield* Realtime.connect({
        model: OpenAILive.model({ id: "gpt-live-1", apiKey: "test-openai-key" }),
        transport: { type: "websocket" },
      }).pipe(Effect.flip)
      expect(error.reason._tag).toBe("InvalidRequest")
    }).pipe(
      Effect.provide(
        RealtimeClient.layer.pipe(
          Layer.provide(dynamicResponse(() => Effect.die("unsupported transport reached the network"))),
        ),
      ),
    ),
  )

  it.effect("creates an OpenAI Realtime WebRTC call via multipart form", () =>
    Effect.gen(function* () {
      const response = yield* Realtime.connect({
        model: OpenAIRealtime.model({
          id: "gpt-realtime-2.1",
          apiKey: "test-openai-key",
          baseURL: "https://openai.test/v1",
        }),
        session: {
          type: "realtime",
          instructions: "Keep answers brief.",
        },
        transport: {
          type: "webrtc",
          sdp: "v=0\r\no=offer\r\n",
          dcid: 4,
        },
      })

      expect(response.model).toBe("gpt-realtime-2.1")
      expect(response.transport).toEqual({
        type: "webrtc",
        sdp: "v=0\r\no=answer\r\n",
      })
    }).pipe(
      Effect.provide(
        RealtimeClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                expect(request.url).toBe("https://openai.test/v1/realtime/calls?dcid=4")
                expect(request.headers.get("authorization")).toBe("Bearer test-openai-key")
                expect(request.headers.get("content-type")).toStartWith("multipart/form-data; boundary=")
                const boundary = input.text.slice(2, input.text.indexOf("\r\n"))
                const form = yield* Effect.promise(() =>
                  new Response(input.text, {
                    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
                  }).formData(),
                )
                expect(form.get("sdp")).toBe("v=0\r\no=offer\r\n")
                expect(JSON.parse(String(form.get("session")))).toEqual({
                  type: "realtime",
                  instructions: "Keep answers brief.",
                  model: "gpt-realtime-2.1",
                })
                return input.respond("v=0\r\no=answer\r\n", {
                  headers: { "content-type": "application/sdp" },
                })
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("creates an OpenAI Realtime WebSocket ephemeral token", () =>
    Effect.gen(function* () {
      const response = yield* Realtime.connect({
        model: OpenAIRealtime.model({
          id: "gpt-realtime-2.1",
          apiKey: "test-openai-key",
          baseURL: "https://openai.test/v1",
        }),
        session: {
          type: "realtime",
          instructions: "Keep answers brief.",
        },
        transport: { type: "websocket" },
      })

      expect(response.model).toBe("gpt-realtime-2.1")
      expect(response.transport).toEqual({
        type: "websocket",
        url: "wss://openai.test/v1/realtime?model=gpt-realtime-2.1",
        token: "ek_openai_123",
        expiresAt: 1760000060,
      })
    }).pipe(
      Effect.provide(
        RealtimeClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                expect(request.url).toBe("https://openai.test/v1/realtime/client_secrets")
                expect(request.headers.get("authorization")).toBe("Bearer test-openai-key")
                expect(JSON.parse(input.text)).toEqual({
                  expires_after: { seconds: 60 },
                  session: {
                    type: "realtime",
                    instructions: "Keep answers brief.",
                    model: "gpt-realtime-2.1",
                  },
                })
                return input.respond(
                  JSON.stringify({
                    value: "ek_openai_123",
                    expires_at: 1760000060,
                  }),
                  { headers: { "content-type": "application/json" } },
                )
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("creates an xAI Grok Voice WebSocket ephemeral token", () =>
    Effect.gen(function* () {
      const response = yield* Realtime.connect({
        model: XAIRealtime.model({
          id: "grok-voice-3.0",
          apiKey: "test-xai-key",
          baseURL: "https://xai.test/v1",
        }),
        session: {
          voice: "ara",
          instructions: "Ignored by client_secrets, sent by client over WS",
        },
        transport: { type: "websocket" },
      })

      expect(response.model).toBe("grok-voice-3.0")
      expect(response.transport).toEqual({
        type: "websocket",
        url: "wss://xai.test/v1/realtime?model=grok-voice-3.0",
        token: "ek_xai_456",
        expiresAt: 1760000120,
      })
    }).pipe(
      Effect.provide(
        RealtimeClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                expect(request.url).toBe("https://xai.test/v1/realtime/client_secrets")
                expect(request.headers.get("authorization")).toBe("Bearer test-xai-key")
                expect(JSON.parse(input.text)).toEqual({
                  expires_after: { seconds: 60 },
                })
                return input.respond(
                  JSON.stringify({
                    value: "ek_xai_456",
                    expires_at: 1760000120,
                  }),
                  { headers: { "content-type": "application/json" } },
                )
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("rejects WebRTC transport on xAI Grok Voice", () =>
    Effect.gen(function* () {
      const error = yield* Realtime.connect({
        model: XAIRealtime.model({ id: "grok-voice-3.0", apiKey: "test-xai-key" }),
        transport: { type: "webrtc", sdp: "v=0\r\n" },
      }).pipe(Effect.flip)
      expect(error.reason._tag).toBe("InvalidRequest")
    }).pipe(
      Effect.provide(
        RealtimeClient.layer.pipe(
          Layer.provide(dynamicResponse(() => Effect.die("unsupported transport reached the network"))),
        ),
      ),
    ),
  )
})
