import { describe, expect } from "bun:test"
import { AIError, HttpContext, ProviderInternalError, RateLimitError, TransportError } from "@opencode/ai"
import { Bus } from "@opencode/core/bus"
import { ModelRetry } from "@opencode/core/model-retry"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/core/provider"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Deferred, Effect } from "effect"
import { TestClock } from "effect/testing"
import { it } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })
const rateLimit = (origin: string, retryAfterMs: number) =>
  new AIError({
    reason: new RateLimitError({
      message: "Rate limited",
      retryAfterMs,
      http: new HttpContext({ url: `https://${origin}.example/v1`, status: 429, headers: {} }),
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

  it.effect("keeps the general allowance for other transient failures", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("extends an in-flight retry wait when another session hits the same provider limit", () =>
    Effect.gen(function* () {
      const bus = { publish: () => Effect.void } as unknown as Bus.Interface
      const firstSession = yield* SessionRunnerRetry.make(bus, SessionSchema.ID.make("ses_shared_wait"))
      const decideSecond = yield* ModelRetry.policy
      const firstError = rateLimit("shared-cooldown-test", 60_000)
      const first = yield* firstSession.decide(input(firstError))
      expect(first.retry).toBe(true)
      if (!first.retry) return

      const completed = yield* Deferred.make<void>()
      yield* firstSession
        .wait({
          decision: first,
          assistantMessageID: SessionMessage.ID.create(),
          error: toSessionError(firstError),
        })
        .pipe(
          Effect.tap(() => Deferred.succeed(completed, undefined)),
          Effect.forkChild({ startImmediately: true }),
        )

      yield* TestClock.adjust("30 seconds")
      const second = yield* decideSecond({ cause: rateLimit("shared-cooldown-test", 120_000), retry: true })
      expect(second?.delay).toBe(120_000)

      // The first request's original deadline was 60s. The second 429 moves the
      // shared origin deadline to 150s, so the already sleeping request must recheck.
      yield* TestClock.adjust("61 seconds")
      expect(yield* Deferred.isDone(completed)).toBe(false)
      yield* TestClock.adjust("60 seconds")
      expect(yield* Deferred.isDone(completed)).toBe(true)
    }),
  )

  it.effect("shares rate-limit cooldowns by origin without pausing unrelated providers", () =>
    Effect.gen(function* () {
      const decide = yield* ModelRetry.policy
      const first = yield* decide({ cause: rateLimit("origin-sharing-test", 30_000), retry: true })
      const sameOrigin = yield* decide({
        cause: rateLimit("origin-sharing-test", 0),
        retry: true,
      })
      const otherOrigin = yield* decide({ cause: rateLimit("other-origin-test", 0), retry: true })

      expect(first?.delay).toBeGreaterThanOrEqual(30_000)
      expect(sameOrigin?.delay).toBeGreaterThanOrEqual(30_000)
      expect(otherOrigin?.delay).toBeLessThan(30_000)
    }),
  )
})
