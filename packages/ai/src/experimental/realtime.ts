import { Effect, Schema } from "effect"
import {
  AIError,
  HttpOptions,
  InvalidRequestError,
  ModelID,
  ProviderID,
  ProviderMetadata,
} from "../schema/index.js"
import { RealtimeClient, Service, type Execute } from "./realtime-client.js"

export const RealtimeWebRTCTransportInput = Schema.Struct({
  type: Schema.Literal("webrtc"),
  sdp: Schema.String,
  dcid: Schema.optional(Schema.Number),
})
export type RealtimeWebRTCTransportInput = Schema.Schema.Type<typeof RealtimeWebRTCTransportInput>

export const RealtimeWebSocketTransportInput = Schema.Struct({
  type: Schema.Literal("websocket"),
})
export type RealtimeWebSocketTransportInput = Schema.Schema.Type<typeof RealtimeWebSocketTransportInput>

export const RealtimeTransportInput = Schema.Union([
  RealtimeWebRTCTransportInput,
  RealtimeWebSocketTransportInput,
]).pipe(Schema.toTaggedUnion("type"))
export type RealtimeTransportInput = Schema.Schema.Type<typeof RealtimeTransportInput>

export const RealtimeWebRTCTransport = Schema.Struct({
  type: Schema.Literal("webrtc"),
  sdp: Schema.String,
})
export type RealtimeWebRTCTransport = Schema.Schema.Type<typeof RealtimeWebRTCTransport>

export const RealtimeWebSocketTransport = Schema.Struct({
  type: Schema.Literal("websocket"),
  url: Schema.String,
  token: Schema.String,
  expiresAt: Schema.Number,
})
export type RealtimeWebSocketTransport = Schema.Schema.Type<typeof RealtimeWebSocketTransport>

export const RealtimeTransport = Schema.Union([RealtimeWebRTCTransport, RealtimeWebSocketTransport]).pipe(
  Schema.toTaggedUnion("type"),
)
export type RealtimeTransport = Schema.Schema.Type<typeof RealtimeTransport>

export const RealtimeSession = Schema.Record(Schema.String, Schema.Unknown)
export type RealtimeSession = Schema.Schema.Type<typeof RealtimeSession>

export interface RealtimeRoute {
  readonly id: string
  readonly connect: (request: RealtimeRequest, execute: Execute) => Effect.Effect<RealtimeResponse, AIError>
}

export class RealtimeModel {
  readonly id: ModelID
  readonly provider: ProviderID
  readonly route: RealtimeRoute
  readonly http?: HttpOptions

  constructor(input: RealtimeModel.Input) {
    this.id = input.id
    this.provider = input.provider
    this.route = input.route
    this.http = input.http
  }

  static make(input: RealtimeModel.MakeInput) {
    return new RealtimeModel({
      id: ModelID.make(input.id),
      provider: ProviderID.make(input.provider),
      route: input.route,
      http: input.http,
    })
  }
}

export namespace RealtimeModel {
  export interface Input {
    readonly id: ModelID
    readonly provider: ProviderID
    readonly route: RealtimeRoute
    readonly http?: HttpOptions
  }

  export interface MakeInput extends Omit<Input, "id" | "provider"> {
    readonly id: string | ModelID
    readonly provider: string | ProviderID
  }
}

export const RealtimeModelSchema = Schema.declare(
  (value): value is RealtimeModel => value instanceof RealtimeModel,
  {
    expected: "Realtime.Model",
  },
)

export class RealtimeRequest extends Schema.Class<RealtimeRequest>("Realtime.Request")({
  model: RealtimeModelSchema,
  session: Schema.optional(RealtimeSession),
  transport: RealtimeTransportInput,
  http: Schema.optional(HttpOptions),
}) {
  declare protected readonly _RealtimeRequest: void
}

export type RealtimeRequestInput = Omit<ConstructorParameters<typeof RealtimeRequest>[0], "http"> & {
  readonly http?: HttpOptions.Input
}

export class RealtimeResponse extends Schema.Class<RealtimeResponse>("Realtime.Response")({
  model: ModelID,
  transport: RealtimeTransport,
  providerMetadata: Schema.optional(ProviderMetadata),
}) {}

export function request(input: RealtimeRequest | RealtimeRequestInput): RealtimeRequest {
  if (input instanceof RealtimeRequest) return input
  return new RealtimeRequest({
    ...input,
    http: HttpOptions.make(input.http),
  })
}

export function connect(input: RealtimeRequest | RealtimeRequestInput): Effect.Effect<RealtimeResponse, AIError, Service> {
  return Effect.try({
    try: () => (input instanceof RealtimeRequest ? input : request(input)),
    catch: (cause) =>
      new AIError({
        reason: new InvalidRequestError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
      }),
  }).pipe(Effect.flatMap(RealtimeClient.connect))
}

export const Realtime = {
  request,
  connect,
} as const
