/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Global } from "@opencode/util/global"
import { testRender } from "@opentui/solid"
import { Effect } from "effect"
import path from "node:path"
import { tmpdirScoped } from "../../../core/test/fixture/tmpdir"
import { it } from "../../../core/test/lib/effect"
import { startServer } from "../../../server/test/fixture/server"
import { ClientProvider, useClient } from "../../src/context/client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventStream, createFetch, json } from "../fixture/tui-client"

it.live("resolves the server home instead of the remote client's home", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const server = yield* startServer(path.join(tmp.path, "config"))
    const api = OpenCode.make({ baseUrl: server.base, headers: server.headers })
    let client!: ReturnType<typeof useClient>
    function Probe() {
      client = useClient()
      return <box />
    }
    yield* Effect.acquireRelease(
      Effect.promise(() =>
        testRender(() => (
          <TestTuiContexts paths={{ home: "/Users/remote-client" }}>
            <ClientProvider api={api}>
              <Probe />
            </ClientProvider>
          </TestTuiContexts>
        )),
      ),
      (setup) => Effect.sync(() => setup.renderer.destroy()),
    )
    expect(yield* Effect.promise(() => client.resolveServerHome())).toBe(Global.Path.home)
  }),
)

test.each([undefined, ""])("treats an unavailable server home (%j) as missing", async (home) => {
  const server = Bun.serve({
    port: 0,
    fetch: createFetch(
      (url) =>
        url.pathname === "/api/info"
          ? json({ version: "test", pid: 0, urls: [], paths: { tmp: "/tmp", home } })
          : undefined,
      createEventStream(),
    ).fetch,
  })
  let client!: ReturnType<typeof useClient>
  function Probe() {
    client = useClient()
    return <box />
  }
  const setup = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={OpenCode.make({ baseUrl: server.url.href })}>
        <Probe />
      </ClientProvider>
    </TestTuiContexts>
  ))
  try {
    expect(await client.resolveServerHome()).toBeUndefined()
  } finally {
    setup.renderer.destroy()
    server.stop(true)
  }
})
