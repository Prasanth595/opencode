export * as WebSearchMcp from "./mcp.js"

import { Duration, Effect, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { collectBoundedResponseBody } from "../../tool/http-body.js"

export const MAX_RESPONSE_BYTES = 256 * 1024

/** Protocol revision sent on the `initialize` handshake. */
export const PROTOCOL_VERSION = "2025-06-18"

export const parseResponse = <F extends Schema.Struct.Fields>(body: string, result: Schema.Struct<F>) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ result })))
  const parse = (payload: string) => {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return Effect.undefined
    return decode(trimmed).pipe(Effect.map((response) => response.result))
  }
  return Effect.gen(function* () {
    const trimmed = body.trim()
    const direct = trimmed ? yield* parse(trimmed) : undefined
    if (direct) return direct
    for (const line of body.split("\n")) {
      if (!line.startsWith("data: ")) continue
      const data = yield* parse(line.substring(6))
      if (data) return data
    }
  })
}

/** Read a response header by name without assuming the client normalized its casing. */
const header = (headers: Readonly<Record<string, string | undefined>>, name: string) => {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue
    const value = headers[key]?.trim()
    if (value) return value
  }
  return undefined
}

/**
 * Perform the MCP `initialize` handshake and return the session id the server minted, if any.
 *
 * Some servers (such as TinyFish in authenticated mode) require `Mcp-Session-Id` on every
 * post-initialize request and reject a bare `tools/call` with HTTP 400
 * `Missing required Mcp-Session-Id header`. Stateless servers answer the handshake without
 * minting a session, so callers can fall back to a plain `call`.
 */
export const initialize = (http: HttpClient.HttpClient, url: string, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.schemaBodyJson(
        Schema.Struct({
          jsonrpc: Schema.Literal("2.0"),
          id: Schema.Literal(1),
          method: Schema.Literal("initialize"),
          params: Schema.Struct({
            protocolVersion: Schema.String,
            capabilities: Schema.Struct({}),
            clientInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
          }),
        }),
      )({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "opencode", version: "1.0" },
        },
      }),
    )
    return yield* Effect.gen(function* () {
      const response = yield* HttpClient.withScope(HttpClient.filterStatusOk(http)).execute(request)
      const session = header(response.headers, "mcp-session-id")
      // Drain the handshake body so the connection is released before the follow-up request.
      yield* Stream.runDrain(response.stream)
      return session
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: Duration.seconds(25),
        orElse: () => Effect.fail(new Error("initialize request timed out")),
      }),
    )
  })

export const call = <F extends Schema.Struct.Fields, R extends Schema.Struct.Fields>(
  http: HttpClient.HttpClient,
  url: string,
  tool: string,
  schema: { readonly input: Schema.Struct<F>; readonly output: Schema.Struct<R> },
  value: Schema.Struct.Type<F>,
  headers: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.schemaBodyJson(
        Schema.Struct({
          jsonrpc: Schema.Literal("2.0"),
          id: Schema.Literal(1),
          method: Schema.Literal("tools/call"),
          params: Schema.Struct({ name: Schema.String, arguments: schema.input }),
        }),
      )({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: value },
      }),
    )
    return yield* Effect.gen(function* () {
      const response = yield* HttpClient.withScope(HttpClient.filterStatusOk(http)).execute(request)
      const body = yield* collectBoundedResponseBody(
        response,
        MAX_RESPONSE_BYTES,
        () => new Error(`${tool} response exceeded ${MAX_RESPONSE_BYTES} bytes`),
      )
      return yield* parseResponse(body.toString("utf8"), schema.output)
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: Duration.seconds(25),
        orElse: () => Effect.fail(new Error(`${tool} request timed out`)),
      }),
    )
  })
