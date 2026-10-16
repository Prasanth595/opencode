import { expect, test } from "bun:test"
import { Effect } from "effect"
import { RestartIntent } from "../src/restart-intent"

const run = <A, E>(effect: Effect.Effect<A, E, RestartIntent.Service>) =>
  Effect.runPromise(Effect.provide(effect, RestartIntent.layer))

test("first resolve wins and late resolvers replay it", async () => {
  const winner = await run(
    Effect.gen(function* () {
      const intent = yield* RestartIntent.Service
      yield* intent.request()
      const first = yield* intent.resolve("now")
      const late = yield* intent.resolve("cancel")
      return { first, late }
    }),
  )
  expect(winner.first).toEqual({ winner: "now", fresh: true })
  expect(winner.late).toEqual({ winner: "now", fresh: false })
})

test("resolve with no pending intent returns undefined", async () => {
  const winner = await run(
    Effect.gen(function* () {
      const intent = yield* RestartIntent.Service
      return yield* intent.resolve("now")
    }),
  )
  expect(winner).toBeUndefined()
})

test("a second request does not clobber the pending intent", async () => {
  const winner = await run(
    Effect.gen(function* () {
      const intent = yield* RestartIntent.Service
      yield* intent.request()
      yield* intent.request()
      return yield* intent.resolve("idle")
    }),
  )
  expect(winner).toEqual({ winner: "idle", fresh: true })
})
