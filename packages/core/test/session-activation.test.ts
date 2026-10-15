import { describe, expect, setDefaultTimeout } from "bun:test"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { SessionStatusEvent } from "@opencode/schema/session-status-event"
import path from "path"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Real Location boot with plugin discovery, so the first request races the initial plugin activation.
setDefaultTimeout(15_000)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, Session.node, LocationServiceMap.node]),
    [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

const project = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  yield* Effect.promise(() =>
    Bun.write(
      path.join(tmp.path, ".opencode/plugins/prompt.ts"),
      `export default {
        id: "prompt-readiness",
        async setup(ctx) {
          await ctx.session.hook("prompt", (event) => {
            event.prompt.text = "Prepared by plugin"
          })
          await ctx.command.transform((editor) =>
            editor.add({ name: "ready", description: "Registered by plugin", execute: async () => {} }),
          )
        },
      }`,
    ),
  )
  return tmp
})

describe("Session waits for plugin activation", () => {
  it.live("publishes busy before cold plugin setup, then clears preparation-only status", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const gate = path.join(tmp.path, "release")
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".opencode/plugins/slow.ts"), `export default {
        id: "slow-readiness", async setup() {
          while (!(await Bun.file(${JSON.stringify(gate)}).exists())) await Bun.sleep(10)
        }
      }`))
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      const busy = yield* Deferred.make<void>()
      const states: string[] = []
      const unsubscribe = yield* bus.listen((event) => Effect.gen(function* () {
        if (event.type !== SessionStatusEvent.Status.type) return
        const data = Schema.decodeUnknownSync(SessionStatusEvent.Status.data)(event.data)
        if (data.sessionID !== session.id) return
        states.push(data.status.type)
        if (data.status.type === "busy") yield* Deferred.succeed(busy, undefined)
      }))
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(gate, "release")).pipe(Effect.asVoid))
      const prompt = yield* sessions.prompt({ sessionID: session.id, text: "Waiting", resume: false }).pipe(Effect.forkScoped)
      yield* Deferred.await(busy).pipe(Effect.timeout("2 seconds"))
      expect(yield* Effect.promise(() => Bun.file(gate).exists())).toBe(false)
      yield* Effect.promise(() => Bun.write(gate, "release"))
      yield* Fiber.join(prompt)
      expect(states).toEqual(["busy", "idle"])
    }),
  )
  it.live("runs prompt hooks from a cold Location before admitting a prompt", () =>
    Effect.gen(function* () {
      const tmp = yield* project
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      const admitted = yield* sessions.prompt({ sessionID: session.id, text: "Original", resume: false })
      expect(admitted.payload.text).toBe("Prepared by plugin")
    }),
  )

  it.live("clears early busy status when preparation fails", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      const states: string[] = []
      const unsubscribe = yield* bus.listen((event) => Effect.sync(() => {
        if (event.type !== SessionStatusEvent.Status.type) return
        const data = Schema.decodeUnknownSync(SessionStatusEvent.Status.data)(event.data)
        if (data.sessionID === session.id) states.push(data.status.type)
      }))
      yield* Effect.addFinalizer(() => unsubscribe)
      const result = yield* sessions.prompt({ sessionID: session.id, text: "Rejected", files: [{ uri: "file:///missing-readiness-attachment.txt" }], resume: false }).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(states).toEqual(["busy", "idle"])
    }),
  )

  it.live("resolves plugin commands from a cold Location", () =>
    Effect.gen(function* () {
      const tmp = yield* project
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
      yield* sessions.command({ sessionID: session.id, command: "ready", text: "now" })
    }),
  )
})
