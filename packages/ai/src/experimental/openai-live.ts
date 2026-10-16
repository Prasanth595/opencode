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

export const DEFAULT_BASE_URL = "https://api.openai.com/v1"

const Response = Schema.Struct({
  session: Schema.Struct({ id: Schema.String }),
  transport: Schema.Struct({ sdp: Schema.String }),
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
      id: "openai-live",
      connect: (req, send) =>
        Effect.gen(function* () {
          if (req.transport.type !== "webrtc")
            return yield* new AIError({
              reason: new InvalidRequestError({
                message: "OpenAI GPT-Live only supports WebRTC transport",
              }),
            })
          const url = new URL(`${baseURL.replace(/\/$/, "")}/live/sessions`)
          Object.entries(req.http?.query ?? {}).forEach(([key, value]) => url.searchParams.set(key, value))
          const body = encodeJson({
            ...req.http?.body,
            session: {
              ...req.session,
              model: req.model.id,
            },
            transport: {
              type: "webrtc",
              sdp: req.transport.sdp,
              ...(req.transport.dcid === undefined ? {} : { dcid: req.transport.dcid }),
            },
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
              reason: new InvalidProviderOutputError({ route: "openai-live", message, body: rawBody, http, cause }),
            })
          const text = yield* res.text.pipe(
            Effect.mapError((cause) => fail("Failed to read the OpenAI GPT-Live response", cause)),
          )
          const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Response))(text).pipe(
            Effect.mapError((cause) => fail("OpenAI GPT-Live returned an invalid response", cause, text)),
          )
          return new RealtimeResponse({
            model: req.model.id,
            transport: {
              type: "webrtc",
              sdp: data.transport.sdp,
            },
            providerMetadata: {
              openai: { sessionId: data.session.id },
            },
          })
        }),
    },
  })
}

export const OpenAILive = { model } as const
