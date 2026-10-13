import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

const npmLayer = (cache: string) =>
  LayerNode.compile(Npm.node, {
    replacements: [Global.node.replace(Global.layerWith({ cache, state: path.join(cache, "state") }))],
  })

test.each([false, true])(
  "server Git plugins load with a separate TUI cache (cached: %s)",
  async (cached) => {
    await using tmp = await tmpdir()
    const repository = path.join(tmp.path, "repository")
    await mkdir(repository)
    await Bun.write(
      path.join(repository, "package.json"),
      JSON.stringify({
        name: "fixture-git-tui",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.js", "./tui": "./tui.js" },
      }),
    )
    await Bun.write(path.join(repository, "index.js"), "export default {}\n")
    await Bun.write(
      path.join(repository, "tui.js"),
      `export default {
      id: "fixture.git-tui",
      setup(context) {
        context.ui.toast.show({ message: "Git TUI plugin loaded", variant: "success" })
      }
    }\n`,
    )
    await Bun.$`git init -q -b fixture ${repository}`
    await Bun.$`git -C ${repository} add .`
    await Bun.$`git -C ${repository} -c user.name=fixture -c user.email=fixture@example.com commit -qm fixture`
    const target = `git+${pathToFileURL(repository).href}#fixture`

    await Effect.gen(function* () {
      const server = yield* Npm.Service.pipe(Effect.provide(npmLayer(path.join(tmp.path, "server-cache"))))
      const installed = yield* server.add(target)
      const client = yield* Npm.Service.pipe(Effect.provide(npmLayer(path.join(tmp.path, "tui-cache"))))
      if (cached) yield* client.add(target)
      const preparations: boolean[] = []
      const inventories: string[] = []
      yield* Effect.promise(async () => {
        await using setup = await createAppFixture({
          config: { animations: false },
          packages: {
            prepare: (spec, install = true) => {
              preparations.push(install)
              return Effect.runPromise(install ? client.add(spec) : client.resolve(spec))
            },
          },
          fetch: (url) => {
            if (url.pathname !== "/api/plugin") return undefined
            inventories.push(url.pathname)
            return json({
              location: { directory, project: { id: "proj_test", directory, canonical: directory } },
              data: [
                {
                  id: "fixture.git-tui",
                  source: { type: "package", target, version: installed.version },
                  features: { server: true, tui: true },
                  state: { status: "active" },
                },
              ],
            })
          },
        })
        await setup.ready
        await setup.waitFor(() => preparations.length > 0)
        expect(preparations).toEqual([true])
        await setup.waitForFrame((frame) => frame.includes("Git TUI plugin loaded"))
        expect(preparations).toEqual([true])
        const prepared = await Effect.runPromise(client.resolve(target))
        expect(prepared.directory).not.toBe(installed.directory)
        expect(await Bun.file(path.join(prepared.directory, "tui.js")).exists()).toBe(true)

        setup.events.emit({ id: "evt_plugins", created: 1, type: "plugin.updated", data: {} })
        await setup.waitFor(() => inventories.length > 1)
        await setup.renderOnce()
        expect(preparations).toEqual([true])
      })
    }).pipe(Effect.scoped, Effect.runPromise)
  },
  30_000,
)
