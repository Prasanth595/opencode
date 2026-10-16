import { OpenCode, type OpenCodeClient } from "@opencode/client/promise"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import {
  resolveRestartApproval,
  type RestartApprovalDecision,
  type RestartApprovalDeps,
} from "../src/commands/handlers/service/restart"

type StubState = {
  active: Record<string, { type: "running" }>
  activeCalls: number
  drainAfterActiveCalls?: number
  activeFails: boolean
  requests: number
  resolves: Array<string>
  winner: RestartApprovalDecision | undefined
  sseConnections: number
}

function startStub(initial: Partial<StubState> = {}) {
  const state: StubState = {
    active: {},
    activeCalls: 0,
    activeFails: false,
    requests: 0,
    resolves: [],
    winner: undefined,
    sseConnections: 0,
    ...initial,
  }
  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const broadcast = (event: unknown) => {
    const chunk = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
    for (const controller of controllers) {
      try {
        controller.enqueue(chunk)
      } catch {
        controllers.delete(controller)
      }
    }
  }
  const resolve = (decision: RestartApprovalDecision) => {
    if (state.winner === undefined) {
      state.winner = decision
      broadcast({ type: "server.restart.resolved", data: { decision: state.winner } })
    }
    return { decision: state.winner }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/api/session/active") {
        state.activeCalls += 1
        if (state.activeFails) return new Response("gone", { status: 500 })
        if (state.drainAfterActiveCalls !== undefined && state.activeCalls > state.drainAfterActiveCalls)
          state.active = {}
        return Response.json({ data: state.active })
      }
      if (request.method === "POST" && url.pathname === "/api/server/restart/request") {
        state.requests += 1
        return Response.json({ active: Object.keys(state.active) })
      }
      if (request.method === "POST" && url.pathname === "/api/server/restart/resolve") {
        const body = (await request.json()) as { decision: RestartApprovalDecision }
        state.resolves.push(body.decision)
        return Response.json(resolve(body.decision))
      }
      if (request.method === "GET" && url.pathname === "/api/event") {
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            state.sseConnections += 1
            controllers.add(controller)
          },
          cancel: (controller) => {
            controllers.delete(controller)
          },
        })
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${server.port}`, headers: {} })
  return { state, client, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const deps = (overrides: Partial<RestartApprovalDeps> = {}): RestartApprovalDeps => ({
  force: false,
  interactive: false,
  ask: () => Effect.succeed<RestartApprovalDecision>("now"),
  resolveTimeoutMs: 5_000,
  idlePollMs: 10,
  onWaiting: () => {},
  ...overrides,
})

const run = (client: OpenCodeClient, input: RestartApprovalDeps) =>
  Effect.runPromise(resolveRestartApproval(client, input))

async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message)
    await Bun.sleep(10)
  }
}

async function tuiResolve(url: string, decision: RestartApprovalDecision) {
  const response = await fetch(`${url}/api/server/restart/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  })
  if (!response.ok) throw new Error(`TUI resolve failed: ${response.status}`)
}

test("no active sessions restarts without requesting approval", async () => {
  const stub = startStub()
  try {
    expect(await run(stub.client, deps())).toBe("now")
    expect(stub.state.requests).toBe(0)
  } finally {
    await stub.stop()
  }
})

test("active sessions with --force restart without requesting approval", async () => {
  const stub = startStub({ active: { ses_1: { type: "running" } } })
  try {
    expect(await run(stub.client, deps({ force: true }))).toBe("now")
    expect(stub.state.requests).toBe(0)
    expect(stub.state.resolves).toEqual([])
  } finally {
    await stub.stop()
  }
})

test("non-TTY waits for a TUI decision and obeys the winner", async () => {
  const stub = startStub({ active: { ses_1: { type: "running" } } })
  try {
    const pending = run(stub.client, deps())
    await until(() => stub.state.sseConnections > 0, "CLI did not subscribe for approval")
    await tuiResolve(stub.url, "now")
    expect(await pending).toBe("now")
    expect(stub.state.requests).toBe(1)
    // The CLI never resolves itself off-terminal; the only resolve is the TUI's.
    expect(stub.state.resolves).toEqual(["now"])
  } finally {
    await stub.stop()
  }
})

test("non-TTY timeout aborts and names --force", async () => {
  const stub = startStub({ active: { ses_1: { type: "running" } } })
  try {
    const error = await run(stub.client, deps({ resolveTimeoutMs: 200 })).then(
      () => undefined,
      (cause: Error) => cause,
    )
    expect(error?.message).toContain("--force")
    expect(stub.state.requests).toBe(1)
    expect(stub.state.resolves).toEqual([])
  } finally {
    await stub.stop()
  }
})

test("a TUI cancel aborts the restart", async () => {
  const stub = startStub({ active: { ses_1: { type: "running" } } })
  try {
    const pending = run(stub.client, deps())
    await until(() => stub.state.sseConnections > 0, "CLI did not subscribe for approval")
    await tuiResolve(stub.url, "cancel")
    const error = await pending.then(
      () => undefined,
      (cause: Error) => cause,
    )
    expect(error?.message).toContain("--force")
  } finally {
    await stub.stop()
  }
})

test("an idle winner waits until sessions finish", async () => {
  const stub = startStub({ active: { ses_1: { type: "running" } }, drainAfterActiveCalls: 3 })
  try {
    const waited: Array<ReadonlyArray<string>> = []
    const pending = run(
      stub.client,
      deps({ onWaiting: (active) => waited.push(active) }),
    )
    await until(() => stub.state.sseConnections > 0, "CLI did not subscribe for approval")
    await tuiResolve(stub.url, "idle")
    expect(await pending).toBe("idle")
    expect(waited.length).toBeGreaterThan(0)
  } finally {
    await stub.stop()
  }
})

test("an idle wait aborts when the server connection drops", async () => {
  const stub = startStub({ active: { ses_1: { type: "running" } } })
  try {
    const pending = run(stub.client, deps())
    await until(() => stub.state.sseConnections > 0, "CLI did not subscribe for approval")
    await tuiResolve(stub.url, "idle")
    await until(() => stub.state.activeCalls > 1, "CLI did not poll for idle")
    stub.state.activeFails = true
    const error = await pending.then(
      () => undefined,
      (cause: Error) => cause,
    )
    expect(error?.message).toContain("Lost connection")
  } finally {
    await stub.stop()
  }
})

test("a TTY pick adopts the first-wins winner", async () => {
  const stub = startStub({ active: { ses_1: { type: "running" } } })
  try {
    // A TUI decides first; the later local pick loses and the winner stands.
    await tuiResolve(stub.url, "cancel")
    const error = await run(stub.client, deps({ interactive: true })).then(
      () => undefined,
      (cause: Error) => cause,
    )
    expect(error?.message).toContain("--force")
    expect(stub.state.resolves).toEqual(["cancel", "now"])
  } finally {
    await stub.stop()
  }
})
