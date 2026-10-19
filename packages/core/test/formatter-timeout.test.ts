import { expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Clock, Deferred, Duration, Effect, Fiber, Option } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Formatter } from "@opencode/core/formatter"
import { Location } from "@opencode/core/location"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Formatter.node, Location.node]), [Location.node.replace(tempLocationLayer)]),
)

it.live("terminates a hung formatter when its deadline expires", () =>
  Effect.gen(function* () {
    const directory = (yield* Location.Service).directory
    const ready = path.join(directory, "ready")
    const scheduled = yield* Deferred.make<void>()
    const expired = yield* Deferred.make<void>()
    const live = Clock.Clock.defaultValue()
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: live.currentTimeMillisUnsafe,
      currentTimeMillis: live.currentTimeMillis,
      currentTimeNanosUnsafe: live.currentTimeNanosUnsafe,
      currentTimeNanos: live.currentTimeNanos,
      monotonicTimeNanosUnsafe: live.monotonicTimeNanosUnsafe,
      monotonicTimeNanos: live.monotonicTimeNanos,
      sleep: (duration) =>
        Duration.toMillis(duration) === 120_000
          ? Deferred.succeed(scheduled, undefined).pipe(Effect.andThen(Deferred.await(expired)))
          : live.sleep(duration),
    }
    const started = yield* Effect.callback<void, Error>((resume) => {
      const watcher = fs.watch(directory, (_event, filename) => {
        if (String(filename) === "ready") resume(Effect.void)
      })
      watcher.on("error", (error) => resume(Effect.fail(error)))
      return Effect.sync(() => watcher.close())
    }).pipe(Effect.forkChild({ startImmediately: true }))
    const formatter = yield* Formatter.Service
    yield* formatter.transform((editor) =>
      editor.set({
        name: "hung",
        extensions: [".timeout"],
        enabled: Effect.succeed([
          process.execPath,
          "-e",
          "const fs = require('fs'); const ready = process.argv.at(-1); fs.writeFileSync(ready + '.tmp', String(process.pid)); fs.renameSync(ready + '.tmp', ready); setInterval(() => {}, 1000)",
          ready,
        ]),
      }),
    )
    const formatting = yield* formatter.file(path.join(directory, "file.timeout")).pipe(
      Effect.provideService(Clock.Clock, clock),
      Effect.forkChild({ startImmediately: true }),
    )
    yield* Fiber.join(started)
    const pid = Number(yield* Effect.promise(() => fs.promises.readFile(ready, "utf8")))
    expect(() => process.kill(pid, 0)).not.toThrow()
    expect(Option.isSome(yield* Deferred.poll(scheduled))).toBe(true)
    yield* Deferred.succeed(expired, undefined)
    expect(yield* Fiber.join(formatting)).toBe(false)
    expect(() => process.kill(pid, 0)).toThrow()
  }),
)
