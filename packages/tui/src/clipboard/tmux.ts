import type { OwnedClipboardService } from "../clipboard"

export function createTmuxClipboard(clipboard: OwnedClipboardService, env = process.env): OwnedClipboardService {
  const pane = env.TMUX_PANE
  if (!env.TMUX || !pane) return clipboard
  return {
    ...clipboard,
    async write(text) {
      // A persistent pane can be reattached from another computer. Its original
      // desktop clipboard and SSH environment do not identify the current client.
      const [client, features] = (
        await runTmux(["display-message", "-p", "-t", pane, "#{client_tty}\n#{client_termfeatures}"], env)
      )
        .trim()
        .split("\n")
      if (!client) throw new Error("No tmux client is attached to copy to")
      if (!features?.split(",").includes("clipboard")) {
        throw new Error("The attached tmux terminal does not advertise clipboard support")
      }
      // This asks tmux to emit OSC 52 itself, so allow-passthrough is not needed.
      await runTmux(["load-buffer", "-w", "-t", client, "-"], env, text.replaceAll("\0", ""))
      // tmux's clipboard feature and exit status do not confirm terminal acceptance.
      return "attempted"
    },
  }
}

async function runTmux(args: string[], env: NodeJS.ProcessEnv, text?: string) {
  const proc = Bun.spawn(["tmux", ...args], {
    env,
    stdin: text === undefined ? "ignore" : new Blob([text]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(stderr.trim() || "tmux clipboard command failed")
  return stdout
}
