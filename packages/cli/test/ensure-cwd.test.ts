import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

describe("ensureCwd", () => {
  test("falls back to home when the process cwd was deleted", async () => {
    const probe = path.join(import.meta.dir, "fixture/ensure-cwd-probe.ts")
    const child = Bun.spawn([process.execPath, "run", probe], {
      cwd: path.join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect({ exitCode, stdout: stdout.trimEnd(), stderr }).toEqual({
      exitCode: 0,
      stdout: `${os.homedir()}\n${os.homedir()}`,
      stderr: `Current directory is not accessible; using ${os.homedir()}\n`,
    })
  })

  test("is a no-op when the process cwd is still valid", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cwd-ok-"))
    try {
      const probe = path.join(import.meta.dir, "fixture/ensure-cwd-probe.ts")
      const child = Bun.spawn([process.execPath, "run", probe, "--keep"], {
        cwd: root,
        env: { ...process.env, PWD: root },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const cwd = fs.realpathSync(root)

      expect({ exitCode, stdout: stdout.trimEnd(), stderr }).toEqual({
        exitCode: 0,
        stdout: `${cwd}\n${root}`,
        stderr: "",
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
