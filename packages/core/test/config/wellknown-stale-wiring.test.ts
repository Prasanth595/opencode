import path from "path"
import { expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { Config } from "@opencode/core/config"
import { Event, type Entry } from "@opencode/schema/config"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/schema/integration"
import { WellKnown } from "@opencode/core/wellknown"
import { KV } from "@opencode/core/kv"
import { Bus } from "@opencode/core/bus"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

/**
 * Well-known fixture: a manifest declaring a distinct auth.env name and a
 * remote config that wires the shared provider's api-key header to that env
 * name. The config endpoint 401s unless the request carries this endpoint's
 * own key, mirroring the issue's "each key is valid only for that endpoint's
 * backend" setup.
 */
const startEndpoint = (env: string, key: string) =>
  Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/.well-known/opencode") {
        return Response.json({
          auth: { command: ["true"], env },
          remote_config: {
            url: `${url.origin}/config`,
            headers: { authorization: `Bearer {env:${env}}` },
          },
        })
      }
      if (url.pathname === "/config") {
        if (request.headers.get("authorization") !== `Bearer ${key}`)
          return new Response("Unauthorized", { status: 401 })
        return Response.json({
          providers: {
            shared: {
              name: "Shared",
              headers: { "x-api-key": `{env:${env}}` },
            },
          },
        })
      }
      return new Response("Not found", { status: 404 })
    },
  })

/** In-memory credential store; the test publishes bus events like the real service. */
const credentialNode = makeGlobalNode({
  service: Credential.Service,
  layer: Layer.effect(
    Credential.Service,
    Effect.gen(function* () {
      const store = new Map<string, Credential.Info[]>()
      return Credential.Service.of({
        all: () => Effect.succeed([...store.values()].flat()),
        list: (integrationID) => Effect.succeed(store.get(integrationID) ?? []),
        get: (id) => Effect.succeed([...store.values()].flat().find((info) => info.id === id)),
        create: (input) =>
          Effect.sync(() => {
            const info = new Credential.Info({
              id: input.id ?? Credential.ID.create(),
              integrationID: input.integrationID,
              label: input.label ?? "default",
              value: input.value,
            })
            store.set(info.integrationID, [...(store.get(info.integrationID) ?? []), info])
            return info
          }),
        activate: () => Effect.void,
        update: () => Effect.void,
        remove: (id) =>
          Effect.sync(() => {
            for (const [integrationID, infos] of store) {
              const next = infos.filter((info) => info.id !== id)
              if (next.length !== infos.length) store.set(integrationID, next)
            }
          }),
      })
    }),
  ),
  deps: [],
})

const testLayer = (directory: string, globalDirectory: string) => {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        { projectDirectory: AbsolutePath.make(directory) },
      ),
    ),
  )
  const built = AppNodeBuilder.build(
    // Group members expose their services to the test; the rest stay private
    // to the Config node's wiring.
    LayerNode.group([Config.node, Bus.node, Credential.node, WellKnown.node, KV.node]),
    [
      Config.node.replace(Config.configured()),
      Location.node.replace(locationLayer),
      Global.node.replace(Global.layerWith({ config: globalDirectory, home: path.join(globalDirectory, "home") })),
      Credential.node.replace(credentialNode),
      Watcher.node.replace(Watcher.testLayer),
    ],
  )
  // Merge the watcher layer by reference so Watcher.Test resolves to the same
  // memoized instance the built graph uses.
  return Layer.mergeAll(built, Watcher.testLayer)
}

it.live(
  "drops the cached config of a logged-out wellknown endpoint instead of wiring an empty api key",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => [startEndpoint("VAR_A", "key-a"), startEndpoint("VAR_B", "key-b")] as const),
      ([serverA, serverB]) =>
        Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
          Effect.flatMap((tmp) =>
            Effect.gen(function* () {
              const config = yield* Config.Service
              const wellknown = yield* WellKnown.Service
              const credentials = yield* Credential.Service
              const bus = yield* Bus.Service

              const originA = serverA.url.origin
              const originB = serverB.url.origin
              const apiKey = (entries: readonly Entry[]) =>
                Config.latest(entries, "providers")?.["shared"]?.headers?.["x-api-key"]

              // Runs a mutation, then waits for the config reload it triggers.
              const reloadAfter = <A, E>(mutation: Effect.Effect<A, E>) =>
                Effect.gen(function* () {
                  const reloaded = yield* bus
                    .subscribe(Event.Updated)
                    .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
                  const result = yield* mutation
                  yield* Fiber.join(reloaded)
                  return result
                })

              const login = (origin: string, key: string) =>
                Effect.gen(function* () {
                  const integrationID = Integration.ID.make(origin)
                  yield* wellknown.add(origin)
                  const credential = yield* credentials.create({ integrationID, value: { type: "key", key } })
                  yield* bus.publish(
                    Credential.Event.Switched,
                    { integrationID, credentialID: credential.id },
                    { global: true },
                  )
                  return credential
                })

              const logout = (origin: string, credentialID: Credential.ID) =>
                Effect.gen(function* () {
                  yield* credentials.remove(credentialID)
                  yield* bus.publish(
                    Credential.Event.Switched,
                    { integrationID: Integration.ID.make(origin), credentialID: null },
                    { global: true },
                  )
                })

              // Login A: the provider wires A's key.
              yield* reloadAfter(login(originA, "key-a"))
              expect(apiKey(yield* config.entries())).toBe("key-a")

              // Login B: both endpoints authenticated, requests work.
              const credentialB = yield* reloadAfter(login(originB, "key-b"))
              expect(apiKey(yield* config.entries())).toBe("key-b")

              // Logout B: the provider must fall back to A's wiring. The stale
              // cached config of B must not resolve {env:VAR_B} to "" and shadow it.
              yield* reloadAfter(logout(originB, credentialB.id))
              expect(apiKey(yield* config.entries())).toBe("key-a")
            }).pipe(Effect.provide(testLayer(tmp.path, path.join(tmp.path, "global")))),
          ),
        ),
      ([serverA, serverB]) =>
        Effect.promise(() => Promise.all([serverA.stop(true), serverB.stop(true)])).pipe(Effect.asVoid),
    ),
  30000,
)
