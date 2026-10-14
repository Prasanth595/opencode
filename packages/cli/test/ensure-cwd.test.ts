import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"

describe("ensureCwd", () => {
  // Windows won't let a process delete the directory it is running in.
  const testOutsideWindows = process.platform === "win32" ? test.skip : test
  testOutsideWindows("falls back to home when the process cwd was deleted", async () => {
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
})
