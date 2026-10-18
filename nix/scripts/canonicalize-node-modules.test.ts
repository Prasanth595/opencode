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
      await writePackage(root, "@ai-sdk+provider-utils@4.0.23+aaaa1111", "@ai-sdk/provider-utils", "4.0.23")
      await writePackage(root, "@ai-sdk+provider-utils@4.0.23+bbbb2222", "@ai-sdk/provider-utils", "4.0.23")
      await writePackage(root, "zod@3.25.76", "zod", "3.25.76")
      await writePackage(root, "zod@4.1.8", "zod", "4.1.8")
      await writePackage(root, "dep@1.0.0", "dep", "1.0.0")

      const winner = join(root, "node_modules/.bun/@opentui+core@1.0.0+aaaa1111/node_modules/@opentui/core")
      const duplicate = join(root, "node_modules/.bun/@opentui+core@1.0.0+bbbb2222/node_modules/@opentui/core")
      const older = join(root, "node_modules/.bun/@opentui+core@0.9.0/node_modules/@opentui/core")
      const providerUtilsZod3 = join(root, "node_modules/.bun/zod@3.25.76/node_modules/zod")
      const providerUtilsZod4 = join(root, "node_modules/.bun/zod@4.1.8/node_modules/zod")

      await link(root, "node_modules/.bun/dep@1.0.0/node_modules/@opentui/core", duplicate)
      await link(root, "node_modules/.bun/node_modules/@opentui/core", duplicate)
      await link(root, "packages/tui/node_modules/@opentui/core", winner)
      await link(root, "packages/theme/node_modules/@opentui/core", duplicate)
      await link(root, "packages/other/node_modules/@opentui/core", older)
      await link(
        root,
        "node_modules/.bun/@ai-sdk+provider-utils@4.0.23+aaaa1111/node_modules/zod",
        providerUtilsZod3,
      )
      await link(
        root,
        "node_modules/.bun/@ai-sdk+provider-utils@4.0.23+bbbb2222/node_modules/zod",
        providerUtilsZod4,
      )

      await run(root)
      await assertCollapsed(root, winner, duplicate, older)
      await assertOtherDuplicatesUntouched(root, providerUtilsZod3, providerUtilsZod4)

      await run(root)
      await assertCollapsed(root, winner, duplicate, older)
      await assertOtherDuplicatesUntouched(root, providerUtilsZod3, providerUtilsZod4)
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

async function assertOtherDuplicatesUntouched(root: string, zod3: string, zod4: string) {
  const provider3 = join(root, "node_modules/.bun/@ai-sdk+provider-utils@4.0.23+aaaa1111")
  const provider4 = join(root, "node_modules/.bun/@ai-sdk+provider-utils@4.0.23+bbbb2222")
  const link3 = join(provider3, "node_modules/zod")
  const link4 = join(provider4, "node_modules/zod")

  expect((await lstat(provider3)).isDirectory()).toBe(true)
  expect((await lstat(provider4)).isDirectory()).toBe(true)
  expect(await readlink(link3)).toBe(zod3)
  expect(await readlink(link4)).toBe(zod4)
  expect(await realpath(link3)).toBe(await realpath(zod3))
  expect(await realpath(link4)).toBe(await realpath(zod4))
  expect(await realpath(link3)).not.toBe(await realpath(link4))
}
