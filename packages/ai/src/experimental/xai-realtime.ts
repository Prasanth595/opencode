import { Effect, Schema } from "effect"
import { Headers, HttpClientRequest } from "effect/http"
import { Auth } from "../route/auth.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import {
  AIError,
  HttpContext,
  HttpOptions,
  InvalidProviderOutputError,
  InvalidRequestError,
  type ModelID,
} from "../schema/index.js"
import { encodeJson } from "../utils/json.js"
import { RealtimeModel, RealtimeResponse } from "./realtime.js"

export const DEFAULT_BASE_URL = "https://api.x.ai/v1"

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
  const auth = AuthOptions.bearer(cfg, "XAI_API_KEY")
  return RealtimeModel.make({
    id: cfg.id,
    provider: "xai",
    http: HttpOptions.make(cfg.http),
    route: {
      id: "xai-realtime",
      connect: (req, send) =>
        Effect.gen(function* () {
          if (req.transport.type !== "websocket")
            return yield* new AIError({
              reason: new InvalidRequestError({
                message: "xAI Grok Voice only supports WebSocket transport",
              }),
            })
          const trimmedBase = baseURL.replace(/\/$/, "")
          const url = new URL(`${trimmedBase}/realtime/client_secrets`)
          Object.entries(req.http?.query ?? {}).forEach(([key, value]) => url.searchParams.set(key, value))
          const body = encodeJson({
            ...req.http?.body,
            expires_after: { seconds: 60 },
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
              reason: new InvalidProviderOutputError({ route: "xai-realtime", message, body: rawBody, http, cause }),
            })
          const text = yield* res.text.pipe(
            Effect.mapError((cause) => fail("Failed to read the xAI Realtime client secret response", cause)),
          )
          const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ClientSecretResponse))(text).pipe(
            Effect.mapError((cause) => fail("xAI Realtime returned an invalid client secret response", cause, text)),
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

export const XAIRealtime = { model } as const
