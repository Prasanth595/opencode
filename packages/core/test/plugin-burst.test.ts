import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { Plugin } from "@opencode/core/plugin"
import { PluginScheduling } from "@opencode/core/plugin/scheduling"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

it.live("services native timers between overlapping initialization checkpoints", () =>
  Effect.gen(function* () {
    let ticks = 0
    const observed: number[] = []
    const timer = setInterval(() => { ticks++ }, 0)
    yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(timer)))
    yield* Effect.forEach([0, 1, 2], () => Effect.gen(function* () {
      for (let index = 0; index < 4; index++) {
        yield* PluginScheduling.checkpoint
        observed.push(ticks)
        const end = performance.now() + 5
        while (performance.now() < end) {}
      }
    }), { concurrency: "unbounded", discard: true })
    expect(observed).toHaveLength(12)
    expect(observed.every((value, index) => index === 0 || value > observed[index - 1]!)).toBe(true)
  }),
)

it.live("services native timers between ordered synchronous plugin activations", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    yield* plugins.awaitActivation
    let observed = false
    let observedBetween = false
    const started: number[] = []
    const timer = setTimeout(() => { observed = true }, 0)
    yield* Effect.addFinalizer(() => Effect.sync(() => clearTimeout(timer)))
    yield* plugins.activate(Array.from({ length: 12 }, (_, index) => ({
      id: `burst-${index}`,
      revision: "1",
      effect: () => Effect.sync(() => {
        // CPU work below the fiber operation-count auto-yield threshold.
        const end = performance.now() + 5
        while (performance.now() < end) {}
        started.push(index)
        if (index === 1) observedBetween = observed
      }),
    })))
    expect(started).toEqual(Array.from({ length: 12 }, (_, index) => index))
    expect(observedBetween).toBe(true)
    expect((yield* plugins.list()).every((plugin) => plugin.state.status === "active")).toBe(true)
  }),
)

it.live("services native timers between reverse-order plugin finalizers", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    let observed = false
    let observedBetween = false
    const stopped: number[] = []
    yield* plugins.activate(Array.from({ length: 12 }, (_, index) => ({
      id: `teardown-${index}`,
      revision: "1",
      effect: () => Effect.addFinalizer(() => Effect.sync(() => {
        const end = performance.now() + 5
        while (performance.now() < end) {}
        stopped.push(index)
        if (index === 10) observedBetween = observed
      })),
    })))
    const timer = setTimeout(() => { observed = true }, 0)
    yield* Effect.addFinalizer(() => Effect.sync(() => clearTimeout(timer)))
    yield* plugins.activate([])
    expect(stopped).toEqual(Array.from({ length: 12 }, (_, index) => 11 - index))
    expect(observedBetween).toBe(true)
    expect(yield* plugins.list()).toEqual([])
  }),
)

it.live("cancels pending setup without leaking readiness holds", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    let started = false
    const fiber = yield* plugins.activate([{
      id: "cancelled",
      revision: "1",
      effect: () => Effect.sync(() => { started = true }),
    }]).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Fiber.interrupt(fiber)
    yield* plugins.awaitActivation
    expect(started).toBe(false)
    expect(yield* plugins.list()).toEqual([])
    yield* plugins.activate([{ id: "replacement", revision: "1", effect: () => Effect.void }])
    expect((yield* plugins.list()).map((plugin) => plugin.id)).toEqual([Plugin.ID.make("replacement")])
  }),
)
