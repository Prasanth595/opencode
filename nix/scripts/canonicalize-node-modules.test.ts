import { describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

const script = join(import.meta.dir, "canonicalize-node-modules.ts")

describe("canonicalize-node-modules", () => {
  test("collapses duplicate store entries for one version and keeps other versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonicalize-"))
    try {
      await writePackage(root, "@opentui+core@1.0.0+aaaa1111", "@opentui/core", "1.0.0")
      await writePackage(root, "@opentui+core@1.0.0+bbbb2222", "@opentui/core", "1.0.0")
      await writePackage(root, "@opentui+core@0.9.0", "@opentui/core", "0.9.0")
      await writePackage(root, "dep@1.0.0", "dep", "1.0.0")

      const winner = join(root, "node_modules/.bun/@opentui+core@1.0.0+aaaa1111/node_modules/@opentui/core")
      const duplicate = join(root, "node_modules/.bun/@opentui+core@1.0.0+bbbb2222/node_modules/@opentui/core")
      const older = join(root, "node_modules/.bun/@opentui+core@0.9.0/node_modules/@opentui/core")

      await link(root, "node_modules/.bun/dep@1.0.0/node_modules/@opentui/core", duplicate)
      await link(root, "node_modules/.bun/node_modules/@opentui/core", duplicate)
      await link(root, "packages/tui/node_modules/@opentui/core", winner)
      await link(root, "packages/theme/node_modules/@opentui/core", duplicate)
      await link(root, "packages/other/node_modules/@opentui/core", older)

      await run(root)
      await assertCollapsed(root, winner, duplicate, older)

      await run(root)
      await assertCollapsed(root, winner, duplicate, older)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writePackage(root: string, entry: string, name: string, version: string) {
  const dir = join(root, "node_modules/.bun", entry, "node_modules", name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }))
}

async function link(root: string, path: string, target: string) {
  const full = join(root, path)
  await mkdir(join(full, ".."), { recursive: true })
  await symlink(target, full)
}

async function run(root: string) {
  const result = Bun.spawnSync([process.execPath, script], { cwd: root })
  expect(result.exitCode).toBe(0)
}

async function assertCollapsed(root: string, winner: string, duplicate: string, older: string) {
  const canonical = await realpath(winner)
  for (const path of [
    "packages/tui/node_modules/@opentui/core",
    "packages/theme/node_modules/@opentui/core",
    "node_modules/.bun/dep@1.0.0/node_modules/@opentui/core",
    "node_modules/.bun/node_modules/@opentui/core",
    "node_modules/.bun/@opentui+core@1.0.0+bbbb2222/node_modules/@opentui/core",
  ]) {
    expect(await realpath(join(root, path))).toBe(canonical)
  }
  expect((await lstat(join(root, "node_modules/.bun/@opentui+core@1.0.0+aaaa1111"))).isDirectory()).toBe(true)
  expect((await lstat(join(root, "node_modules/.bun/@opentui+core@1.0.0+bbbb2222"))).isSymbolicLink()).toBe(true)
  expect(await readlink(join(root, "node_modules/.bun/@opentui+core@1.0.0+bbbb2222"))).toBe("@opentui+core@1.0.0+aaaa1111")
  expect((await lstat(join(root, "node_modules/.bun/@opentui+core@0.9.0"))).isDirectory()).toBe(true)
  expect(await realpath(join(root, "packages/other/node_modules/@opentui/core"))).toBe(await realpath(older))
  expect(await realpath(older)).not.toBe(canonical)
}
