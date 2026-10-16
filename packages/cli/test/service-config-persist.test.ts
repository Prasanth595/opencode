import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const real = await import("@opencode/client/effect/service")
// Simulate the service dying (or the CLI losing its session) while stopping:
// the config change must already be on disk so the next start picks it up.
mock.module("@opencode/client/effect/service", () => ({
  ...real,
  Service: {
    ...real.Service,
    stop: () => Effect.fail(new Error("service stop interrupted")),
  },
}))

const { ServiceConfig } = await import("../src/services/service-config")

function run<A, E>(root: string, effect: Effect.Effect<A, E, Global.Service | import("effect").FileSystem.FileSystem>) {
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  return Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)))
}

async function freshRoot(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return { root, file: path.join(root, "config", ServiceConfig.filename()) }
}

test("service set persists env before stopping, even when the stop is interrupted", async () => {
  const { root, file } = await freshRoot("opencode-service-set-env-persist-")
  try {
    await expect(run(root, ServiceConfig.set("env", "OPENCODE_SET_ENV_TEST", "kept"))).rejects.toThrow(
      "service stop interrupted",
    )
    expect(await Bun.file(file).json()).toEqual({ env: { OPENCODE_SET_ENV_TEST: "kept" } })
    expect(await run(root, ServiceConfig.get("env", "OPENCODE_SET_ENV_TEST"))).toBe("kept")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("service set persists scalar settings before stopping, even when the stop is interrupted", async () => {
  const { root, file } = await freshRoot("opencode-service-set-scalar-persist-")
  try {
    await expect(run(root, ServiceConfig.set("hostname", "127.0.0.2"))).rejects.toThrow("service stop interrupted")
    expect(await Bun.file(file).json()).toEqual({ hostname: "127.0.0.2" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("service unset persists env removal before stopping, even when the stop is interrupted", async () => {
  const { root, file } = await freshRoot("opencode-service-unset-env-persist-")
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, JSON.stringify({ env: { OPENCODE_UNSET_ENV_TEST: "stale", OTHER: "kept" } }))
    await expect(run(root, ServiceConfig.unset("env", "OPENCODE_UNSET_ENV_TEST"))).rejects.toThrow(
      "service stop interrupted",
    )
    expect(await Bun.file(file).json()).toEqual({ env: { OTHER: "kept" } })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
