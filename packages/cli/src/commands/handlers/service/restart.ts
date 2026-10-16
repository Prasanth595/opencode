import { select } from "@clack/prompts"
import { EOL } from "node:os"
import { Effect } from "effect"
import { Service } from "@opencode/client/effect/service"
import { OpenCode, isInvalidRequestError, type OpenCodeClient } from "@opencode/client/promise"
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
  readonly ask: (active: ReadonlyArray<string>) => Effect.Effect<RestartApprovalDecision, unknown, never>
  readonly resolveTimeoutMs: number
  readonly idlePollMs: number
  readonly onWaiting: (active: ReadonlyArray<string>) => void
}

// Approval gate for restarting a managed server with running sessions. The event
// subscription starts before the intent request so a resolution cannot slip
// through between them; only decisions recorded after the request count.
// Resolves to the winning decision ("now" when nothing needs approval); "cancel"
// and approval timeouts fail instead of restarting. A local pick is adopted from
// the resolve response, falling back to the broadcast winner on a lost race.
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
  const watcher = watchResolved(client)
  const approval = Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => client.server.restart.request(),
      catch: (cause) => new Error("Could not reach server to request restart approval", { cause }),
    })
    watcher.arm()
    const winner = deps.interactive
      ? yield* resolveInteractive(client, deps, watcher, ids)
      : yield* resolveRemote(client, deps, watcher)
    if (winner === "cancel") return yield* Effect.fail(restartAborted(ids, deps.interactive))
    if (winner === "idle") yield* waitForIdle(client, deps)
    return winner
  })
  return yield* approval.pipe(Effect.ensuring(Effect.sync(() => watcher.dispose())))
})

const resolveInteractive = Effect.fn("cli.service.restart.approval.interactive")(function* (
  client: OpenCodeClient,
  deps: RestartApprovalDeps,
  watcher: ResolvedWatcher,
  active: ReadonlyArray<string>,
) {
  const picked = yield* deps.ask(active)
  return yield* Effect.tryPromise({
    // Pass the rejection through unchanged so catchIf can read its `_tag`.
    try: () => client.server.restart.resolve({ decision: picked }),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((resolved) => resolved.decision),
    // Another surface won the race; adopt the broadcast winner instead.
    Effect.catchIf(isInvalidRequestError, () => awaitWinner(client, watcher, deps)),
    Effect.mapError((cause) => new Error("Could not reach server to resolve restart approval", { cause })),
  )
})

const resolveRemote = Effect.fn("cli.service.restart.approval.remote")(function* (
  client: OpenCodeClient,
  deps: RestartApprovalDeps,
  watcher: ResolvedWatcher,
) {
  return yield* awaitWinner(client, watcher, deps)
})

const awaitWinner = Effect.fn("cli.service.restart.approval.wait")(function* (
  client: OpenCodeClient,
  watcher: ResolvedWatcher,
  deps: RestartApprovalDeps,
) {
  return yield* Effect.tryPromise({
    try: () => watcher.wait(deps.resolveTimeoutMs),
    catch: (cause) =>
      cause instanceof RestartApprovalTimeout
        ? new Error("Timed out waiting for restart approval with sessions still running.")
        : new Error("Lost connection to the server while waiting for restart approval", { cause }),
  }).pipe(
    Effect.tapError(() =>
      // Release TUIs stuck on our intent; a settled intent replays its winner.
      Effect.tryPromise(() => client.server.restart.resolve({ decision: "cancel" })).pipe(Effect.ignore),
    ),
  )
})

// The requesting session blocks on this command, so it can never go idle while
// watched. Exclude it from the drain set; approval itself still required it.
const waitForIdle = Effect.fn("cli.service.restart.approval.idle")(function* (
  client: OpenCodeClient,
  deps: RestartApprovalDeps,
) {
  while (true) {
    yield* Effect.sleep(deps.idlePollMs)
    const active = yield* Effect.tryPromise({
      try: () => client.session.active(),
      catch: (cause) =>
        new Error("Lost connection to the server while waiting for sessions to finish", { cause }),
    })
    const ids = Object.keys(active).filter((id) => id !== process.env.OPENCODE_SESSION_ID)
    if (ids.length === 0) return
    deps.onWaiting(ids)
  }
})

function restartAborted(active: ReadonlyArray<string>, interactive: boolean) {
  return interactive
    ? new Error(
        `Restart cancelled with ${active.length} active session(s); re-run with --force to restart immediately.`,
      )
    : new Error("Restart cancelled with active session(s) still running.")
}

class RestartApprovalTimeout extends Error {
  constructor() {
    super("restart approval timed out")
    this.name = "RestartApprovalTimeout"
  }
}

export type ResolvedWatcher = {
  readonly arm: () => void
  readonly wait: (timeoutMs: number) => Promise<RestartApprovalDecision>
  readonly dispose: () => void
}

export function watchResolved(client: OpenCodeClient): ResolvedWatcher {
  const controller = new AbortController()
  let armed = false
  let pending: RestartApprovalDecision | undefined
  let settle: ((decision: RestartApprovalDecision) => void) | undefined
  let failure: unknown | undefined
  const fail = (cause: unknown) => {
    failure ??= cause
    settle = undefined
  }
  void (async () => {
    try {
      const stream = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
      for (;;) {
        const next = await stream.next()
        if (next.done) break
        if (armed && next.value.type === "server.restart.resolved") {
          const decision = next.value.data.decision
          pending ??= decision
          settle?.(decision)
        }
      }
      fail(new Error("Event stream disconnected while waiting for restart approval"))
    } catch (cause) {
      fail(cause)
    }
  })()
  return {
    arm() {
      armed = true
    },
    wait(timeoutMs: number) {
      return new Promise<RestartApprovalDecision>((resolve, reject) => {
        if (pending !== undefined) return resolve(pending)
        if (failure !== undefined) return reject(failure)
        const timer = setTimeout(() => reject(new RestartApprovalTimeout()), timeoutMs)
        settle = (decision) => {
          clearTimeout(timer)
          resolve(decision)
        }
      })
    },
    dispose() {
      controller.abort()
    },
  }
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
