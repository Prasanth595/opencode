import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isolatedEnv } from "./fixture/environment"
import { compactDatabase } from "../src/commands/handlers/db/maintenance"

test("vacuum converts an existing database and reclaims deleted pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-db-vacuum-"))
  const filename = join(dir, "legacy.db")
  const database = new Database(filename)
  let databaseClosed = false
  try {
    database.exec("CREATE TABLE history (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)")
    const insert = database.prepare("INSERT INTO history (id, payload) VALUES (?, ?)")
    for (let id = 0; id < 1_400; id++) insert.run(id, Buffer.alloc(4_096))
    database.exec("DELETE FROM history")
    expect(Number(database.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count)).toBeGreaterThan(1_024)
    database.close()
    databaseClosed = true

    const result = compactDatabase(filename)
    expect(result.afterBytes).toBeLessThan(result.beforeBytes)

    const compacted = new Database(filename, { readonly: true })
    try {
      expect(compacted.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 })
      expect(Number(compacted.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count)).toBe(0)
    } finally {
      compacted.close()
    }
  } finally {
    if (!databaseClosed) {
      if (database.inTransaction) database.run("ROLLBACK")
      database.close()
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test("db vacuum command runs without a service registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-db-vacuum-cli-"))
  try {
    const result = await runVacuum(root)
    expect(result).toMatchObject({ exitCode: 0, stderr: "" })
    expect(result.stdout).toContain("Database vacuum complete")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("db vacuum command refuses a live registered service process", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-db-vacuum-live-service-"))
  try {
    const state = join(root, "state", "opencode")
    await mkdir(state, { recursive: true })
    await writeFile(
      join(state, "service-local.json"),
      JSON.stringify({ url: "http://127.0.0.1:1", pid: process.pid, version: "test" }),
    )

    const result = await runVacuum(root)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("still running")
    expect(result.stdout).toBe("")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("vacuum reports a busy database without continuing maintenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-db-vacuum-busy-"))
  const filename = join(dir, "busy.db")
  const owner = new Database(filename)
  try {
    owner.exec("CREATE TABLE history (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
    owner.exec("BEGIN EXCLUSIVE")
    expect(() => compactDatabase(filename)).toThrow("stop every OpenCode process")
  } finally {
    if (owner.inTransaction) owner.exec("ROLLBACK")
    owner.close()
    await rm(dir, { recursive: true, force: true })
  }
})

async function runVacuum(root: string) {
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../src/index.ts"), "db", "vacuum"], {
    cwd: join(import.meta.dir, ".."),
    env: isolatedEnv(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}
