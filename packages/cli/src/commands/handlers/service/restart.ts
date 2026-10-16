import { select } from "@clack/prompts"
import { EOL } from "os"
import { Effect } from "effect"
import { Service } from "@opencode/client/effect/service"
import { OpenCode, type OpenCodeClient } from "@opencode/client/promise"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"
import { ServerConnection } from "../../../services/server-connection"
import { prompt } from "../../../ui/prompt"

export default Runtime.handler(
  Commands.commands.service.commands.restart,
  Effect.fn("cli.service.restart")(function* (input: Runtime.Input<typeof Commands.commands.service.commands.restart>) {
    const options = yield* ServiceConfig.options()
    const endpoint = yield* Service.discover(options)
    if (endpoint !== undefined && !input.force) {
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
      yield* resolveRestartApproval(client, {
        force: input.force,
        interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
        ask: askRestartDecision,
        resolveTimeoutMs: 120_000,
        idlePollMs: 2_000,
        onWaiting: (active) =>
          process.stdout.write(`Waiting for ${active.length} active session(s) to finish...${EOL}`),
      })
    }
    // Keep this explicit: automatic service replacement must preserve terminals.
    yield* ServerConnection.shutdownPersistentPty(options).pipe(Effect.ignore)
    yield* Service.stop(options)
    const transport = yield* Service.ensure(options)
    process.stdout.write(transport.url + EOL)
  }),
)

export type RestartApprovalDecision = "now" | "idle" | "cancel"

export type RestartApprovalDeps = {
  readonly force: boolean
  readonly interactive: boolean
  readonly ask: (active: ReadonlyArray<string>) => Effect.Effect<RestartApprovalDecision, unknown>
  readonly resolveTimeoutMs: number
  readonly idlePollMs: number
  readonly onWaiting: (active: ReadonlyArray<string>) => void
}

// Approval gate for restarting a managed server with running sessions. Resolves to the winning
// decision ("now" when nothing needs approval); "cancel" and approval timeouts fail instead of
// restarting. The server counts the first resolve as the winner, so a local pick is adopted
// from the resolve response rather than trusted blindly.
export const resolveRestartApproval = Effect.fn("cli.service.restart.approval")(function* (
  client: OpenCodeClient,
  deps: RestartApprovalDeps,
) {
  const active = yield* Effect.tryPromise({
    try: () => client.session.active(),
    catch: (cause) => new Error("Could not reach server to check active sessions", { cause }),
  })
  const ids = Object.keys(active)
  if (ids.length === 0) return "now"
  if (deps.force) return "now"
  yield* Effect.tryPromise({
    try: () => client.server.restart.request(),
    catch: (cause) => new Error("Could not reach server to request restart approval", { cause }),
  })
  const winner = deps.interactive ? yield* resolveInteractive(client, deps, ids) : yield* resolveRemote(client, deps)
  if (winner === "cancel") return yield* Effect.fail(restartAborted(ids))
  if (winner === "idle") yield* waitForIdle(client, deps, ids)
  return winner
})

const resolveInteractive = Effect.fn("cli.service.restart.approval.interactive")(function* (
  client: OpenCodeClient,
  deps: RestartApprovalDeps,
  active: ReadonlyArray<string>,
) {
  const picked = yield* deps.ask(active)
  const resolved = yield* Effect.tryPromise({
    try: () => client.server.restart.resolve({ decision: picked }),
    catch: (cause) => new Error("Could not reach server to resolve restart approval", { cause }),
  })
  return resolved.decision
})

const resolveRemote = Effect.fn("cli.service.restart.approval.remote")(function* (
  client: OpenCodeClient,
  deps: RestartApprovalDeps,
) {
  return yield* Effect.tryPromise({
    try: () => waitForResolvedEvent(client, deps.resolveTimeoutMs),
    catch: (cause) =>
      cause instanceof RestartApprovalTimeout
        ? new Error(
            "Timed out waiting for restart approval; no connected client approved the restart. Re-run with --force to restart immediately.",
          )
        : new Error("Lost connection to the server while waiting for restart approval", { cause }),
  })
})

const waitForIdle = Effect.fn("cli.service.restart.approval.idle")(function* (
  client: OpenCodeClient,
  deps: RestartApprovalDeps,
  initial: ReadonlyArray<string>,
) {
  deps.onWaiting(initial)
  while (true) {
    yield* Effect.sleep(deps.idlePollMs)
    const active = yield* Effect.tryPromise({
      try: () => client.session.active(),
      catch: (cause) =>
        new Error("Lost connection to the server while waiting for sessions to finish", { cause }),
    })
    const ids = Object.keys(active)
    if (ids.length === 0) return
    deps.onWaiting(ids)
  }
})

function restartAborted(active: ReadonlyArray<string>) {
  return new Error(
    `Restart cancelled with ${active.length} active session(s); re-run with --force to restart immediately.`,
  )
}

class RestartApprovalTimeout extends Error {
  constructor() {
    super("restart approval timed out")
    this.name = "RestartApprovalTimeout"
  }
}

function waitForResolvedEvent(client: OpenCodeClient, timeoutMs: number): Promise<RestartApprovalDecision> {
  return (async () => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const stream = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
      while (true) {
        const next = await stream.next()
        if (next.done) break
        if (next.value.type === "server.restart.resolved") return next.value.data.decision
      }
      if (timedOut) throw new RestartApprovalTimeout()
      throw new Error("Event stream disconnected while waiting for restart approval")
    } catch (cause) {
      if (timedOut) throw new RestartApprovalTimeout()
      throw cause
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  })()
}

const askRestartDecision = (active: ReadonlyArray<string>) =>
  prompt<RestartApprovalDecision>(() =>
    select<RestartApprovalDecision>({
      message: `${active.length} session(s) are still running. Restart the background server?`,
      options: [
        { value: "now", label: "Restart now", hint: "Interrupt running sessions" },
        { value: "idle", label: "Wait for idle", hint: "Restart when sessions finish" },
        { value: "cancel", label: "Cancel", hint: "Keep the server running" },
      ],
    }),
  )
