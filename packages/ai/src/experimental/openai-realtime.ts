import { Effect, Schema } from "effect"
import { Headers, HttpClientRequest } from "effect/http"
import { Auth } from "../route/auth.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import {
  AIError,
  HttpContext,
  HttpOptions,
  InvalidProviderOutputError,
  type ModelID,
} from "../schema/index.js"
import { encodeJson } from "../utils/json.js"
import { RealtimeModel, RealtimeResponse } from "./realtime.js"

export const DEFAULT_BASE_URL = "https://api.openai.com/v1"

const ClientSecretResponse = Schema.Struct({
  value: Schema.String,
  expires_at: Schema.Number,
})

export type ModelInput = ProviderAuthOption<"optional"> & {
  readonly id: string | ModelID
  readonly baseURL?: string
  readonly headers?: Record<string, string>
  readonly http?: HttpOptions.Input
}

export const model = (cfg: ModelInput) => {
  const baseURL = cfg.baseURL ?? DEFAULT_BASE_URL
  const auth = AuthOptions.bearer(cfg, "OPENAI_API_KEY")
  return RealtimeModel.make({
    id: cfg.id,
    provider: "openai",
    http: HttpOptions.make(cfg.http),
    route: {
      id: "openai-realtime",
      connect: (req, send) =>
        Effect.gen(function* () {
          const trimmedBase = baseURL.replace(/\/$/, "")
          const session = {
            ...req.session,
            model: req.model.id,
          }
          if (req.transport.type === "webrtc") {
            const url = new URL(`${trimmedBase}/realtime/calls`)
            if (req.transport.dcid !== undefined) url.searchParams.set("dcid", String(req.transport.dcid))
            Object.entries(req.http?.query ?? {}).forEach(([key, value]) => url.searchParams.set(key, value))
            const form = new FormData()
            form.append("sdp", req.transport.sdp)
            form.append("session", encodeJson(session))
            const headers = yield* Auth.toEffect(auth)({
              request: req,
              method: "POST",
              url: url.toString(),
              body: "[multipart/form-data]",
              headers: Headers.remove(Headers.fromInput({ ...cfg.headers, ...req.http?.headers }), "content-type"),
            })
            const res = yield* send(
              HttpClientRequest.post(url).pipe(
                HttpClientRequest.setHeaders(headers),
                HttpClientRequest.bodyFormData(form),
              ),
            )
            const http = new HttpContext({ url: res.request.url, status: res.status, headers: res.headers })
            const sdp = yield* res.text.pipe(
              Effect.mapError(
                (cause) =>
                  new AIError({
                    reason: new InvalidProviderOutputError({
                      route: "openai-realtime",
                      message: "Failed to read the OpenAI Realtime SDP response",
                      http,
                      cause,
                    }),
                  }),
              ),
            )
            if (!sdp.trim())
              return yield* new AIError({
                reason: new InvalidProviderOutputError({
                  route: "openai-realtime",
                  message: "OpenAI Realtime returned an empty SDP answer",
                  body: sdp,
                  http,
                }),
              })
            return new RealtimeResponse({
              model: req.model.id,
              transport: {
                type: "webrtc",
                sdp,
              },
            })
          }

          const url = new URL(`${trimmedBase}/realtime/client_secrets`)
          Object.entries(req.http?.query ?? {}).forEach(([key, value]) => url.searchParams.set(key, value))
          const body = encodeJson({
            ...req.http?.body,
            expires_after: { seconds: 60 },
            session,
          })
          const headers = yield* Auth.toEffect(auth)({
            request: req,
            method: "POST",
            url: url.toString(),
            body,
            headers: Headers.fromInput({ ...cfg.headers, ...req.http?.headers }),
          })
          const res = yield* send(
            HttpClientRequest.post(url).pipe(
              HttpClientRequest.setHeaders(headers),
              HttpClientRequest.bodyText(body, "application/json"),
            ),
          )
          const http = new HttpContext({ url: res.request.url, status: res.status, headers: res.headers })
          const fail = (message: string, cause: unknown, rawBody?: string) =>
            new AIError({
              reason: new InvalidProviderOutputError({ route: "openai-realtime", message, body: rawBody, http, cause }),
            })
          const text = yield* res.text.pipe(
            Effect.mapError((cause) => fail("Failed to read the OpenAI Realtime client secret response", cause)),
          )
          const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ClientSecretResponse))(text).pipe(
            Effect.mapError((cause) => fail("OpenAI Realtime returned an invalid client secret response", cause, text)),
          )
          const wsUrl = new URL(`${trimmedBase}/realtime`)
          wsUrl.protocol = wsUrl.protocol === "http:" ? "ws:" : "wss:"
          wsUrl.searchParams.set("model", req.model.id)
          return new RealtimeResponse({
            model: req.model.id,
            transport: {
              type: "websocket",
              url: wsUrl.toString(),
              token: data.value,
              expiresAt: data.expires_at,
            },
          })
        }),
    },
  })
}

export const OpenAIRealtime = { model } as const
