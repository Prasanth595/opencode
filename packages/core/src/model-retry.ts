export * as ModelRetry from "./model-retry.js"

import { AIError, isRetryable } from "@opencode/ai"
import { Clock, Duration, Effect, Pull, Schedule } from "effect"

interface Input {
  readonly cause: AIError
  readonly retry: boolean
}

export interface Decision {
  readonly attempt: number
  readonly delay: number
  readonly retry: boolean
  /** The upstream origin whose 429 response established this shared cooldown. */
  readonly cooldownKey?: string
}

const cooldowns = new Map<string, number>()

const cooldownKey = (input: Input) => {
  if (input.cause.reason._tag !== "RateLimit") return undefined
  try {
    const url = new URL(input.cause.reason.http?.url ?? "")
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    return url.origin
  } catch {
    return undefined
  }
}

const pruneCooldowns = (now: number) => {
  for (const [origin, until] of cooldowns) if (until <= now) cooldowns.delete(origin)
}

/** Bound provider-requested delays so a hostile or buggy retry-after cannot stall a call for hours. */
const RETRY_AFTER_MAX = Duration.toMillis("15 minutes")

const retryAfter = (input: Input) => {
  if (input.cause.reason._tag === "RateLimit" || input.cause.reason._tag === "ProviderInternal")
    return input.cause.reason.retryAfterMs === undefined
      ? undefined
      : Math.min(input.cause.reason.retryAfterMs, RETRY_AFTER_MAX)
  return undefined
}

// Exponential from 2s capped at 10s per gap, for 10 retries: 2, 4, 8, then 10 × 7, about 84s of
// waiting when every attempt fails (67–101s with jitter). `min` takes the faster schedule, so the
// cap applies per gap; `max` with `recurs` bounds the count.
const schedule = Schedule.max([
  Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("10 seconds")]),
  Schedule.recurs(10),
]).pipe(
  Schedule.jittered,
  Schedule.setInputType<Input>(),
  Schedule.modifyDelay(({ input, duration: delay }) => {
    const minimum = retryAfter(input)
    const duration = minimum === undefined ? delay : Duration.max(delay, Duration.millis(minimum))
    return Effect.succeed(Duration.millis(Math.ceil(Duration.toMillis(duration))))
  }),
)

// A timed-out attempt already waited minutes before failing, so the general allowance would let a
// dead provider hold a call for most of an hour. Cap those attempts well below it.
const MAX_TIMEOUT_RETRIES = 3

export const policy = Effect.gen(function* () {
  const step = yield* Schedule.toStep(schedule)
  let attempt = 1
  let timeouts = 0
  return (input: Input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const next = yield* step(now, input).pipe(Pull.catchDone(() => Effect.succeed(undefined)))
      if (!next) return undefined
      const [, duration] = next
      attempt++
      if (input.cause.reason._tag === "Transport" && input.cause.reason.code === "Timeout") timeouts++
      let delay = Math.ceil(Duration.toMillis(duration))
      const key = cooldownKey(input)
      if (input.retry && key) {
        const until = Math.max(cooldowns.get(key) ?? 0, now + delay)
        cooldowns.set(key, until)
        pruneCooldowns(now)
        delay = Math.max(delay, until - now)
      }
      return {
        attempt,
        delay,
        retry: input.retry && timeouts <= MAX_TIMEOUT_RETRIES,
        cooldownKey: key,
      }
    })
})

/** Wait through the local retry delay and any newer cooldown published by another session. */
export const wait = (decision: Decision, scheduledAt?: number) =>
  Effect.gen(function* () {
    const localUntil = (scheduledAt ?? (yield* Clock.currentTimeMillis)) + decision.delay
    while (true) {
      const now = yield* Clock.currentTimeMillis
      pruneCooldowns(now)
      const sharedUntil = decision.cooldownKey ? (cooldowns.get(decision.cooldownKey) ?? 0) : 0
      const remaining = Math.max(localUntil, sharedUntil) - now
      if (remaining <= 0) return
      yield* Effect.sleep(Duration.millis(remaining))
    }
  })

/** Absolute deadline used by both session events and retry waiting. */
export const readyAt = (decision: Decision, scheduledAt: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    pruneCooldowns(now)
    const sharedUntil = decision.cooldownKey ? (cooldowns.get(decision.cooldownKey) ?? 0) : 0
    return Math.max(scheduledAt + decision.delay, sharedUntil)
  })

/** Retry a buffered model call from scratch; failed attempts never contribute to its returned output. */
export const retry = <A, R>(effect: Effect.Effect<A, AIError, R>) =>
  Effect.gen(function* () {
    const decide = yield* policy
    while (true) {
      const result = yield* Effect.result(effect)
      if (result._tag === "Success") return result.success
      const decision = yield* decide({ cause: result.failure, retry: isRetryable(result.failure) })
      if (!decision?.retry) return yield* result.failure
      const scheduledAt = yield* Clock.currentTimeMillis
      yield* wait(decision, scheduledAt)
    }
  })
