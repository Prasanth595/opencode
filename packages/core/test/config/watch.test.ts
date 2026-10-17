import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import type { ConfigDiscovery } from "@opencode/core/config/discovery"
import { ConfigWatch } from "@opencode/core/config/watch"
import { AbsolutePath } from "@opencode/core/schema"
import { Effect, Fiber, Stream } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"

const it = testEffect(LayerNode.compile(FSUtil.node))

const project = path.resolve("watch-plan-project")
const root = AbsolutePath.make(path.join(project, ".opencode"))
const sources: ConfigDiscovery.Sources = {
  direct: ["opencode.json", "opencode.jsonc"].map((name) => AbsolutePath.make(path.join(project, name))),
  project: [{ path: root, present: false }],
  claude: [AbsolutePath.make(path.join(project, ".claude"))],
  agents: [AbsolutePath.make(path.join(project, ".agents"))],
}

describe("ConfigWatch.plan", () => {
  it.live("groups missing candidates and keeps parent watches when roots appear", () =>
    Effect.gen(function* () {
      const missing = yield* ConfigWatch.plan(sources)
      expect(Array.from(missing.values())).toEqual([
        {
          path: project,
          type: "entries",
          names: [".agents", ".claude", ".opencode", "opencode.json", "opencode.jsonc"],
        },
      ])
      const present = yield* ConfigWatch.plan({ ...sources, project: [{ path: root, present: true }] })
      expect(Array.from(present.values())).toEqual([
        { path: root, type: "directory", ignore: ["node_modules", ".git", "**/{node_modules,.git}/**"] },
        ...missing.values(),
      ])
    }),
  )

  it.live("adds exact watches for explicit files only when not already covered", () =>
    Effect.gen(function* () {
      expect(yield* ConfigWatch.plan({ ...sources, explicit: sources.direct[0] })).toEqual(
        yield* ConfigWatch.plan(sources),
      )
      const present = { ...sources, project: [{ path: root, present: true }] }
      expect(
        yield* ConfigWatch.plan({ ...present, explicit: AbsolutePath.make(path.join(root, "custom.json")) }),
      ).toEqual(yield* ConfigWatch.plan(present))
      const directory = path.resolve("watch-plan-external")
      expect(
        Array.from(
          (yield* ConfigWatch.plan({ ...sources, explicit: AbsolutePath.make(path.join(directory, "custom.json")) }))
            .values(),
        ),
      ).toContainEqual({ path: directory, type: "entries", names: ["custom.json"] })
    }),
  )

  // inotify refuses a watch on the symlink itself (`Not a directory`), and events report real paths, so a plan
  // that keeps the link never observes edits made through it.
  it.live("resolves a symlinked global directory to its target", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const real = path.join(tmp.path, "real", "opencode")
          const link = path.join(tmp.path, "xdg", "opencode")
          yield* Effect.promise(async () => {
            await fs.mkdir(real, { recursive: true })
            await fs.mkdir(path.dirname(link), { recursive: true })
            await fs.symlink(real, link, process.platform === "win32" ? "junction" : undefined)
          })

          const plan = yield* ConfigWatch.plan({ ...sources, global: AbsolutePath.make(link) })
          expect(Array.from(plan.values())).toContainEqual({
            path: AbsolutePath.make(yield* Effect.promise(() => fs.realpath(real))),
            type: "directory",
            ignore: ["node_modules", ".git", "**/{node_modules,.git}/**"],
          })
          expect(Array.from(plan.values()).some((target) => target.path === link)).toBe(false)
        }),
      ),
    ),
  )
})

// End-to-end: a real inotify subscription on the planned path must see edits made through the symlink.
const describeNative = Watcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip
describeNative("ConfigWatch.plan native symlink", () => {
  it.live("watches the resolved target so edits through the link arrive", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const real = path.join(tmp.path, "real", "opencode")
          const link = path.join(tmp.path, "xdg", "opencode")
          yield* Effect.promise(async () => {
            await fs.mkdir(real, { recursive: true })
            await fs.mkdir(path.dirname(link), { recursive: true })
            await fs.symlink(real, link, process.platform === "win32" ? "junction" : undefined)
          })

          const plan = yield* ConfigWatch.plan({ ...sources, global: AbsolutePath.make(link) })
          const directory = Array.from(plan.values()).find((target) => target.type === "directory")
          expect(directory).toBeDefined()

          const watcher = yield* Watcher.Service
          const received = yield* watcher
            .subscribe(directory!)
            .pipe(Effect.flatMap((stream) => Stream.runHead(stream)), Effect.forkScoped({ startImmediately: true }))
          yield* Effect.sleep("200 millis")

          // Write through the link, exactly as a dotfiles setup edits the config.
          yield* Effect.promise(() => fs.writeFile(path.join(link, "opencode.json"), "{}"))

          // A failed subscription leaves the stream pending forever, so require the real event rather than
          // treating an empty timeout as success.
          const update = yield* Fiber.join(received).pipe(Effect.timeout("15 seconds"))
          expect(update).toMatchObject({ _tag: "Some", value: { path: path.join(real, "opencode.json") } })
        }).pipe(Effect.provide(LayerNode.compile(Watcher.node))),
      ),
    ),
  )
})
