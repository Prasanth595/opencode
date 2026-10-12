import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Credential } from "@opencode/core/credential"
import { Config } from "@opencode/core/config"
import { Bus } from "@opencode/core/bus"
import { Form } from "@opencode/core/form"
import { Integration } from "@opencode/core/integration"
import { WebSearch } from "@opencode/core/websearch"
import { testEffect } from "../lib/effect"

interface WebSearchRequest {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

interface WebSearchResponse {
  readonly body: string
  readonly status: number
  readonly headers: Record<string, string>
}

export const requests: WebSearchRequest[] = []
export const signals: AbortSignal[] = []
let response: WebSearchResponse = { body: "", status: 200, headers: {} }
let initializeResponse: WebSearchResponse | undefined

export function resetWebSearchFixture(body: string, status = 200, headers: Record<string, string> = {}) {
  requests.length = 0
  signals.length = 0
  response = { body, status, headers }
  initializeResponse = undefined
}

/** Answer an MCP `initialize` handshake separately from `tools/call`, for session-minting providers. */
export function setInitializeResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  initializeResponse = { body, status, headers }
}

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request, _url, signal) =>
    Effect.sync(() => {
      signals.push(signal)
      if (request.body._tag !== "Uint8Array") throw new Error(`Unexpected request body: ${request.body._tag}`)
      const body = JSON.parse(new TextDecoder().decode(request.body.body))
      requests.push({
        url: request.url,
        headers: request.headers,
        body,
      })
      const selected = body?.method === "initialize" && initializeResponse ? initializeResponse : response
      return HttpClientResponse.fromWeb(
        request,
        new Response(selected.body, { status: selected.status, headers: selected.headers }),
      )
    }),
  ),
)

export const webSearchIntegrationTest = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, Bus.node, Form.node, WebSearch.node]), [
      Config.node.replace(Config.testLayer()),
    ]),
    http,
  ),
)
