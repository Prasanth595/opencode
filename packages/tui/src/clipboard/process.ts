import { createInterface } from "node:readline"
import { Schema } from "effect"
import { access } from "node:fs/promises"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

export type ClipboardProcess = ReturnType<typeof createClipboardProcess>

export function createClipboardProcess(command: ReadonlyArray<string>) {
  const children = new Map<ChildProcessWithoutNullStreams, Promise<number | null>>()
  let lease: ChildProcessWithoutNullStreams | undefined
  return {
    async write(text: string, env: NodeJS.ProcessEnv, client?: number) {
      const child = spawn(command[0], command.slice(1), {
        env: { ...env, OPENCODE_CLIPBOARD_HELPER: "1", OPENCODE_SSH_ASKPASS_PORT: undefined },
        stdio: ["pipe", "pipe", "pipe"],
      })
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      const stderr: string[] = []
      child.stderr.setEncoding("utf8").on("data", (text: string) => stderr.push(text))
      child.stdin.on("error", () => child.kill())
      children.set(child, exited)
      void exited.then(
        () => children.delete(child),
        () => children.delete(child),
      )
      const timeout = setTimeout(() => child.kill(), 10_000)
      const reader = child.stdout.iterator({ destroyOnReturn: false })
      let ready = false
      try {
        child.stdin.write(JSON.stringify(text) + "\n")
        const response = await reader.next()
        if (response.done || response.value[0] !== 1) {
          await exited
          throw new Error(stderr.join("").trim() || "Clipboard helper did not accept the copy")
        }
        lease?.stdin.end()
        lease = child
        // An open forwarded X11 channel otherwise keeps ssh alive after tmux
        // detaches. Release the selection owner when that tmux client exits.
        if (client !== undefined) {
          const detached = setInterval(() => {
            void access(`/proc/${client}`).catch(() => {
              clearInterval(detached)
              child.stdin.end()
            })
          }, 250)
          detached.unref()
          void exited.then(() => clearInterval(detached))
        }
        ready = true
      } finally {
        clearTimeout(timeout)
        await reader.return?.()
        if (!ready) child.kill()
      }
    },
    async dispose() {
      children.forEach((_, child) => child.stdin.end())
      await Promise.all(children.values())
    },
  }
}

// Run in a separate process: native clipboard libraries read the process
// environment, and a tmux client may belong to a different desktop after attach.
export async function runClipboardProcess() {
  const { createHostClipboard } = await import("@opentui/core")
  const clipboard = createHostClipboard()
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  try {
    for await (const line of input) {
      const text = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))(line)
      const result = await clipboard.writeText(text, { selection: "clipboard" })
      if (result.status === "failed") throw result.error
      if (result.status !== "written") throw new Error(`Desktop clipboard write ${result.status}`)
      process.stdout.write(Buffer.from([1]))
      // Keep stdin open so the X11 selection owner can serve paste requests.
    }
  } finally {
    input.close()
    await clipboard.dispose()
  }
}
