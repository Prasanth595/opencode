import { describe, expect } from "bun:test"
import { AIError, HttpContext, ProviderInternalError, TransportError } from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/core/provider"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Effect } from "effect"
import { it } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })
const gatewayTimeout = new AIError({
  reason: new ProviderInternalError({ message: "Streaming response failed: [504] Provider timed out after 362397ms" }),
})
const badGateway = new AIError({
  reason: new ProviderInternalError({ message: "Streaming response failed: [502] Upstream error" }),
})
const socketTimeout = new AIError({
  reason: new TransportError({
    message: "Timed out waiting for WebSocket data",
    transport: "websocket",
    operation: "read",
    code: "idle-timeout",
  }),
})

const input = (cause: AIError) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(cause),
})

// Decisions for `count` consecutive failures of the same cause within one step.
const decisions = (cause: AIError, count: number) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
    const results: boolean[] = []
    for (let i = 0; i < count; i++) results.push((yield* policy(input(cause))).retry)
    return results
  })

describe("SessionRunnerRetry.policy", () => {
  it.effect("stops retrying transport timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(yield* decisions(timeout, 4)).toEqual([true, true, true, false])
    }),
  )

  it.effect("stops retrying gateway-reported provider timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(yield* decisions(gatewayTimeout, 4)).toEqual([true, true, true, false])
    }),
  )

  it.effect("counts 504 responses without a timeout message toward the timeout cap", () =>
    Effect.gen(function* () {
      const gatewayStatus = new AIError({
        reason: new ProviderInternalError({
          message: "upstream unavailable",
          http: new HttpContext({ url: "https://example.com/v1", status: 504, headers: {} }),
        }),
      })
      expect(yield* decisions(gatewayStatus, 4)).toEqual([true, true, true, false])
    }),
  )

  it.effect("keeps the general allowance for other transient failures", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 10)).toEqual(Array(10).fill(true))
    }),
  )

  it.effect("keeps the general allowance for fast failures like 502", () =>
    Effect.gen(function* () {
      expect(yield* decisions(badGateway, 10)).toEqual(Array(10).fill(true))
    }),
  )

  it.effect("keeps websocket idle timeouts on the general allowance", () =>
    Effect.gen(function* () {
      expect(yield* decisions(socketTimeout, 10)).toEqual(Array(10).fill(true))
    }),
  )
})
