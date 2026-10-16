import { Context, Effect, Layer } from "effect"
import { RequestExecutor } from "../route/executor.js"
import { AIError, mergeHttpOptions } from "../schema/index.js"
import { sanitizeSurrogates } from "../utils/sanitize.js"
import { RealtimeRequest, type RealtimeResponse } from "./realtime.js"

export type Execute = RequestExecutor.Interface["execute"]

export interface Interface {
  readonly connect: (request: RealtimeRequest) => Effect.Effect<RealtimeResponse, AIError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AI/Experimental/RealtimeClient") {}

export const connect = (request: RealtimeRequest): Effect.Effect<RealtimeResponse, AIError, Service> =>
  Effect.flatMap(Service, (client) => client.connect(request))

export const layer: Layer.Layer<Service, never, RequestExecutor.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const executor = yield* RequestExecutor.Service
    return Service.of({
      connect: (request) =>
        request.model.route.connect(
          new RealtimeRequest({
            ...sanitizeSurrogates({
              session: request.session,
              transport: request.transport,
              http: mergeHttpOptions(request.model.http, request.http),
            }),
            model: request.model,
          }),
          executor.execute,
        ),
    })
  }),
)

export const fetchLayer = layer.pipe(Layer.provideMerge(RequestExecutor.fetchLayer))

export const RealtimeClient = {
  Service,
  layer,
  fetchLayer,
  connect,
} as const
