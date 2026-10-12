import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const keep = process.argv.includes("--keep")
if (!keep) {
  const ghost = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-ghost-cwd-"))
  process.chdir(ghost)
  process.env.PWD = ghost
  fs.rmdirSync(ghost)
}

await import("../../src/ensure-cwd")
process.stdout.write(`${process.cwd()}\n${process.env.PWD ?? ""}`)
