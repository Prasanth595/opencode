import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createTmuxClipboard } from "../src/clipboard/tmux"

test.skipIf(process.platform !== "linux" || !Bun.which("tmux") || !Bun.which("script"))(
  "copies to an attached tmux client with default passthrough settings",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-clipboard-"))
    const socket = path.join(dir, "tmux.sock")
    const run = (args: string[]) =>
      Bun.spawnSync(["tmux", "-S", socket, ...args], {
        env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
      })
    const pane = new TextDecoder()
      .decode(run(["-f", "/dev/null", "new-session", "-d", "-s", "copy", "-P", "-F", "#{pane_id}", "sleep 60"]).stdout)
      .trim()
    const attach = (term = "xterm-256color") => {
      const proc = Bun.spawn(
        ["script", "-q", "-c", `tmux -S '${socket.replaceAll("'", "'\''")}' attach -t copy`, "/dev/null"],
        {
          env: { ...process.env, TERM: term, TMUX: undefined, TMUX_PANE: undefined },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        },
      )
      return { proc, output: new Response(proc.stdout).text() }
    }
    const connected = async () => {
      const deadline = Date.now() + 5000
      while (!new TextDecoder().decode(run(["list-clients", "-F", "#{client_tty}"]).stdout).trim()) {
        if (Date.now() > deadline) throw new Error("tmux client did not attach")
        await Bun.sleep(10)
      }
    }
    const clients = [attach()]
    try {
      await connected()
      expect(new TextDecoder().decode(run(["show-options", "-g", "allow-passthrough"]).stdout).trim()).toBe(
        "allow-passthrough off",
      )
      const clipboard = createTmuxClipboard(
        {
          read: async () => undefined,
          write: async () => {
            throw new Error("must not copy to the original host or use OSC 52 passthrough")
          },
          dispose: async () => {},
        },
        { ...process.env, TMUX: `${socket},0,0`, TMUX_PANE: pane },
      )
      expect(await clipboard.write("reattached\0 client\n世界")).toBe("attempted")
      expect(new TextDecoder().decode(run(["save-buffer", "-"]).stdout)).toBe("reattached client\n世界")

      run(["detach-client", "-s", "copy"])
      await expect(clipboard.write("no client")).rejects.toThrow("No tmux client is attached")
      expect(await clients[0].output).toContain(Buffer.from("reattached client\n世界").toString("base64"))

      // Reuse the original clipboard service after attaching a different client.
      clients.push(attach())
      await connected()
      await clipboard.write("second client")
      run(["detach-client", "-s", "copy"])
      expect(await clients[1].output).toContain(Buffer.from("second client").toString("base64"))
      expect(await clients[0].output).not.toContain(Buffer.from("second client").toString("base64"))

      clients.push(attach("vt100"))
      await connected()
      await expect(clipboard.write("unsupported terminal")).rejects.toThrow("does not advertise clipboard support")
    } finally {
      run(["kill-server"])
      clients.forEach((client) => client.proc.kill())
      await Promise.all(clients.map((client) => client.proc.exited))
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test("keeps the normal clipboard outside tmux", () => {
  const clipboard = {
    read: async () => undefined,
    write: async () => "written" as const,
    dispose: async () => {},
  }
  expect(createTmuxClipboard(clipboard, {})).toBe(clipboard)
})
