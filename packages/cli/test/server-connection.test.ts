import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { OPENCODE_VERSION } from "../src/version"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServerConnection } from "../src/services/server-connection"
import { ServiceConfig } from "../src/services/service-config"
import { isolatedEnv } from "./fixture/environment"

test("resolution groups Effect-native lifecycle operations only for the managed service", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-resolution-"))
  const id = "server-resolution-test"
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        version: OPENCODE_VERSION,
        pid: process.pid,
        urls: [],
      })
    },
  })
  const registration = path.join(root, "state", ServiceConfig.filename())
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer), Effect.scoped))

  try {
    await fs.mkdir(path.dirname(registration), { recursive: true })
    await fs.writeFile(
      registration,
      JSON.stringify({
        id,
        version: OPENCODE_VERSION,
        url: server.url.toString(),
        pid: process.pid,
      }),
    )
    const resolved = await runPromise(ServerConnection.resolve())

    expect(resolved.endpoint.url).toBe(server.url.toString())
    expect(resolved.service).toBeDefined()
    if (!resolved.service) throw new Error("Expected managed service capabilities")
    expect(Effect.isEffect(resolved.service.reconnect())).toBe(true)
    expect(Effect.isEffect(resolved.service.restart())).toBe(true)
    expect(await runPromise(resolved.service.reconnect())).toEqual(resolved.endpoint)

    const explicit = await runPromise(ServerConnection.resolve({ server: server.url.toString() }))
    expect(explicit.endpoint.url).toBe(server.url.toString())
    expect(explicit.service).toBeUndefined()
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("service options only require a matching version when requested", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-options-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer), Effect.scoped))

  try {
    expect((await runPromise(ServiceConfig.options())).version).toBeUndefined()
    expect((await runPromise(ServiceConfig.options({ checkVersion: true }))).version).toBe(OPENCODE_VERSION)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("CLI loopback requests bypass environment proxies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-loopback-proxy-"))
  const proxied: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [] })
    },
  })
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      proxied.push(request.url)
      return new Response(null, { status: 502 })
    },
  })
  const env = isolatedEnv(root, {
    OPENCODE_PASSWORD: "fixture-password",
    OPENCODE_SERVER_PASSWORD: undefined,
    HTTP_PROXY: proxy.url.href,
    http_proxy: proxy.url.href,
    HTTPS_PROXY: proxy.url.href,
    https_proxy: proxy.url.href,
    ALL_PROXY: proxy.url.href,
    all_proxy: proxy.url.href,
    NO_PROXY: "",
    no_proxy: "",
  })
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        path.join(import.meta.dir, "../src/index.ts"),
        "api",
        "get",
        "/api/info",
        "--server",
        server.url.href,
      ],
      { cwd: path.join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ stderr, code }).toEqual({ stderr: "", code: 0 })
    expect(JSON.parse(stdout)).toMatchObject({ version: OPENCODE_VERSION, pid: process.pid })
    expect(proxied).toEqual([])
  } finally {
    await server.stop(true)
    await proxy.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})
