export * as WarmingPlugin from "./warming.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { SessionEvent } from "@opencode/schema/session-event"
import type { Session } from "@opencode/schema/session"
import { Clock, Duration, Effect, Scope, Stream } from "effect"
import { Config } from "../config.js"

const defaults = {
  prompt: "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK",
  interval: Duration.minutes(4),
  duration: Duration.minutes(30),
}

export const Plugin = define({
  id: "opencode.warming",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const loadSettings = Effect.fn("WarmingPlugin.loadSettings")(function* () {
      const warming = Config.latest(yield* config.entries(), "warming")
      if (!warming) return
      const settings = warming === true ? defaults : { ...defaults, ...warming }
      const interval = Duration.toMillis(settings.interval)
      const duration = Duration.toMillis(settings.duration)
      if (Number.isFinite(interval) && interval > 0 && Number.isFinite(duration) && duration > 0) return settings
      yield* Effect.logWarning("warming interval and duration must be finite positive durations")
    })

    const scope = yield* Scope.Scope
    const sessions = new Map<Session.ID, { last: number; expires: number; settings: typeof defaults }>()
    type ExecutionEvent =
      | SessionEvent.Execution.Started
      | SessionEvent.Execution.Succeeded
      | SessionEvent.Execution.Failed
      | SessionEvent.Execution.Interrupted
    // Sessions with a real turn in flight. Warming keeps an idle session's context cached, so a
    // keep-alive request sent while the session is working only competes with the request it is
    // meant to keep warm — on a slow single-slot model the two starve each other. Execution events
    // bracket a busy period, and every terminal outcome clears it (succeeded, failed, interrupted),
    // unlike a response hook that a failed request never reaches.
    const working = new Set<Session.ID>()
    yield* ctx.event.subscribe().pipe(
      Stream.filter(
        (event): event is ExecutionEvent =>
          event.type === "session.execution.started" ||
          event.type === "session.execution.succeeded" ||
          event.type === "session.execution.failed" ||
          event.type === "session.execution.interrupted",
      ),
      Stream.runForEach((event) => {
        if (event.type === "session.execution.started") working.add(event.data.sessionID)
        else working.delete(event.data.sessionID)
        return Effect.void
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
    const loop: (sessionID: Session.ID) => Effect.Effect<void> = Effect.fn("WarmingPlugin.loop")(
      function* (sessionID) {
        const current = sessions.get(sessionID)
        if (!current) return

        const now = yield* Clock.currentTimeMillis
        const next = Math.min(current.last + Duration.toMillis(current.settings.interval), current.expires)
        if (now < next) {
          yield* Effect.sleep(Duration.millis(next - now))
          return yield* loop(sessionID)
        }
        if (now >= current.expires) {
          sessions.delete(sessionID)
          return
        }
        // Defer, do not drop: the next wake after the turn settles warms again, and the window
        // still expires on its own, so a busy period that never reports an outcome cannot keep
        // warming alive past its configured duration.
        if (working.has(sessionID)) {
          yield* Effect.logInfo("deferring session warm while the session is working", { sessionID })
          yield* Effect.sleep(
            Duration.millis(Math.min(Duration.toMillis(current.settings.interval), current.expires - now)),
          )
          return yield* loop(sessionID)
        }

        const last = current.last
        yield* Effect.logInfo("warming session", { sessionID, last })
        yield* ctx.session
          .generate({ sessionID, prompt: current.settings.prompt })
          .pipe(Effect.catchCause((cause) => Effect.logWarning("failed to warm session", { sessionID, cause })))
        const latest = sessions.get(sessionID)
        if (latest === current && latest.last === last) latest.last = yield* Clock.currentTimeMillis
        return yield* loop(sessionID)
      },
    )

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
        if (session.parentID) return

        const active = sessions.get(event.sessionID)
        const settings = yield* loadSettings()
        if (!settings) {
          sessions.delete(event.sessionID)
          return
        }

        // Once generate exposes request metadata to context hooks, tag warm requests instead of matching the prompt.
        const message = event.messages.at(-1)
        if (
          message?.role === "user" &&
          message.content.length === 1 &&
          message.content[0]?.type === "text" &&
          (message.content[0].text === active?.settings.prompt || message.content[0].text === settings.prompt)
        ) {
          if (active) active.settings = settings
          return
        }

        const now = yield* Clock.currentTimeMillis
        const duration = Duration.toMillis(settings.duration)
        if (active) {
          active.last = now
          active.expires = now + duration
          active.settings = settings
          return
        }
        sessions.set(event.sessionID, { last: now, expires: now + duration, settings })
        yield* Effect.logInfo("scheduled session warming", {
          sessionID: event.sessionID,
          interval: settings.interval,
          expires: now + duration,
        })
        yield* loop(event.sessionID).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("session warming loop failed", { sessionID: event.sessionID, cause }),
          ),
          Effect.forkIn(scope),
        )
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
})
