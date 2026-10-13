/** @jsxImportSource @opentui/solid */
import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Global } from "@opencode/util/global"
import { testRender } from "@opentui/solid"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdirScoped } from "../../../core/test/fixture/tmpdir"
import { it } from "../../../core/test/lib/effect"
import { startServer } from "../../../server/test/fixture/server"
import { ClientProvider, useClient } from "../../src/context/client"
import { directoryAutocomplete, directoryRecentValue } from "../../src/prompt/directory-completion"
import { TestTuiContexts } from "../fixture/tui-environment"

it.live("uses server home for remote directory completion and recent paths", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const current = path.join(tmp.path, "project")
    yield* Effect.promise(() => fs.mkdir(current))
    const server = yield* startServer(path.join(tmp.path, "config"))
    const api = OpenCode.make({ baseUrl: server.base, headers: server.headers })
    let client!: ReturnType<typeof useClient>
    function Probe() {
      client = useClient()
      return <box />
    }
    const setup = yield* Effect.acquireRelease(
      Effect.promise(() =>
        testRender(() => (
          <TestTuiContexts paths={{ home: "/Users/remote-client", cwd: current }}>
            <ClientProvider api={api}>
              <Probe />
            </ClientProvider>
          </TestTuiContexts>
        )),
      ),
      (setup) => Effect.sync(() => setup.renderer.destroy()),
    )
    const home = yield* Effect.promise(() => client.resolveServerHome())
    if (!home) throw new Error("Server did not report its home directory")
    expect(home).toBe(Global.Path.home)
    expect(home).not.toBe("/Users/remote-client")
    const completions = yield* Effect.promise(() => directoryAutocomplete(api.file, { directory: current }, "~", home))
    expect(completions[0]).toEqual({ value: "~", absolute: home })
    const destination = yield* Effect.promise(() => api.location.get({ location: { directory: home } }))
    expect(destination.directory).toBe(home)
    expect(directoryRecentValue(destination.directory, home)).toBe("~")
    expect(directoryRecentValue("/Users/remote-client/project", home)).toBe("/Users/remote-client/project")
    expect(setup.renderer.isDestroyed).toBe(false)
  }),
)
