import { describe, expect } from "bun:test"
import { Message } from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { WarmingPlugin } from "@opencode/core/plugin/warming"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Document } from "@opencode/schema/config"
import { Event } from "@opencode/schema/event"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionEvent } from "@opencode/schema/session-event"
import { DateTime, Effect, Queue, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { it } from "../lib/effect"
import { host } from "./host"

const sessionID = Session.ID.make("ses_warming_test")
const prompt = "keep-alive"
const session = Session.Info.make({
  id: sessionID,
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})

const started: SessionEvent.Execution.Started = {
  id: Event.ID.create(),
  created: 0,
  durable: { aggregateID: sessionID, seq: Event.Seq.make(0), version: Event.Version.make(1) },
  type: "session.execution.started",
  data: { sessionID },
}

const succeeded: SessionEvent.Execution.Succeeded = {
  id: Event.ID.create(),
  created: 0,
  durable: { aggregateID: sessionID, seq: Event.Seq.make(1), version: Event.Version.make(1) },
  type: "session.execution.succeeded",
  data: { sessionID },
}

type ExecutionEvent = SessionEvent.Execution.Started | SessionEvent.Execution.Succeeded

const config = (interval: string, duration: string) =>
  Config.testLayer([
    Schema.decodeUnknownSync(Document)({
      type: "document",
      info: { warming: { prompt, interval, duration } },
    }),
  ])

const turn = (text: string): SessionContext => ({
  sessionID,
  agent: Agent.ID.make("build"),
  model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") },
  system: [],
  messages: [Message.user(text)],
  tools: {},
  options: {},
})

/** Runs the plugin against a stub host, exposing the warmed prompts and the execution event feed. */
const warming = (interval: string, duration: string) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ExecutionEvent>()
    const warmed = new Array<string>()
    let contextHook: ((input: SessionContext) => Effect.Effect<void>) | undefined
    yield* WarmingPlugin.Plugin.effect(
      host({
        event: { subscribe: () => Stream.fromQueue(events) },
        session: {
          get: () => Effect.succeed(session),
          generate: (input) =>
            Effect.sync(() => {
              warmed.push(input.prompt)
              return { text: "OK" }
            }),
          hook: (name, callback) => {
            if (name === "context") contextHook = callback as (input: SessionContext) => Effect.Effect<void>
            return Effect.succeed({ dispose: Effect.void })
          },
        },
      }),
    ).pipe(Effect.provide(config(interval, duration)))
    if (!contextHook) return yield* Effect.die("warming plugin did not register a context hook")
    return { events, warmed, contextHook }
  })

// The execution-event subscription is a forked fiber, so an offered event is only applied once that
// fiber has been scheduled. Yielding is a scheduler hand-off rather than a timer, which keeps the
// sequence identical on every machine; a hop count too small would make the busy assertions below
// fail loudly, never pass for the wrong reason.
const quiesce = Effect.gen(function* () {
  for (let hop = 0; hop < 5; hop++) yield* Effect.yieldNow
})

const send = (events: Queue.Queue<ExecutionEvent>, event: ExecutionEvent) =>
  Effect.gen(function* () {
    yield* Queue.offer(events, event)
    yield* quiesce
  })

/** Drives the pending TestClock timers, without ever consulting the wall clock. */
const advance = Effect.fnUntraced(function* (condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return
    yield* quiesce
    yield* TestClock.adjust("500 millis")
  }
  return yield* Effect.die(new Error("condition never became true after 100 advances"))
})

describe("WarmingPlugin", () => {
  it.effect("warms an idle session at the configured interval", () =>
    Effect.gen(function* () {
      const plugin = yield* warming("1 second", "30 minutes")
      yield* plugin.contextHook(turn("hello"))
      yield* advance(() => plugin.warmed.length > 0)
      expect(plugin.warmed).toEqual([prompt])
    }),
  )

  it.effect("defers warming while the session is working and resumes once it settles", () =>
    Effect.gen(function* () {
      const plugin = yield* warming("1 second", "30 minutes")
      yield* send(plugin.events, started)
      yield* plugin.contextHook(turn("hello"))
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("1 second")
      yield* quiesce
      expect(plugin.warmed).toEqual([])
      yield* send(plugin.events, succeeded)
      yield* advance(() => plugin.warmed.length > 0)
      expect(plugin.warmed).toEqual([prompt])
    }),
  )

  it.effect("counts the interval from when the session went idle, not from when the turn started", () =>
    Effect.gen(function* () {
      const plugin = yield* warming("1 second", "30 minutes")
      yield* send(plugin.events, started)
      yield* plugin.contextHook(turn("hello"))
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("500 millis")
      // The turn ends at 2.5s, after the request that started it, so a turn-anchored interval is
      // already spent and would warm at 3s — seconds after the real response, when the cache is
      // fresh. Anchoring on idle pushes that first warm to 3.5s.
      yield* send(plugin.events, succeeded)
      yield* TestClock.adjust("500 millis")
      yield* quiesce
      expect(plugin.warmed).toEqual([])
      yield* advance(() => plugin.warmed.length > 0)
      expect(plugin.warmed).toEqual([prompt])
    }),
  )

  it.effect("stops warming when the window expires during a turn that never settles", () =>
    Effect.gen(function* () {
      const plugin = yield* warming("1 second", "2 seconds")
      yield* send(plugin.events, started)
      yield* plugin.contextHook(turn("hello"))
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("1 second")
      yield* send(plugin.events, succeeded)
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("1 second")
      yield* quiesce
      expect(plugin.warmed).toEqual([])
    }),
  )
})
