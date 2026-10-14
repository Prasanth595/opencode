import { describe, expect, test } from "bun:test"
import { Effect, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { OpenRouterPlugin } from "@opencode/core/plugin/provider/openrouter"
import { Provider } from "@opencode/core/provider"
import { Document, Info } from "@opencode/schema/config"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpenRouterPlugin.effect(host)
})

const router = (respond: (request: Request) => Response | Promise<Response>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const requests: { url: string; headers: Headers }[] = []
      const server = Bun.serve({
        port: 0,
        fetch: (request) => {
          requests.push({ url: request.url, headers: new Headers(request.headers) })
          return respond(request)
        },
      })
      return { requests, server, url: `${server.url.origin}/api/v1` }
    }),
    ({ server }) => Effect.promise(() => server.stop(true)),
  )

const inventory = (...ids: string[]) => Response.json({ data: ids.map((id) => ({ id })) })
const connect = Effect.fn(function* (key = "secret", configuration?: Credential.Key["configuration"]) {
  const credentials = yield* Credential.Service
  return yield* credentials.create({
    integrationID: Integration.ID.make("openrouter"),
    value: Credential.Key.make({ type: "key", key, configuration }),
  })
})
const seed = (url: string) =>
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    const integrations = yield* Integration.Service
    yield* integrations.transform((editor) => {
      editor.update(Integration.ID.make("openrouter"), (integration) => {
        integration.name = "OpenRouter"
      })
    })
    yield* providers.transform((editor) => {
      editor.update(Provider.ID.openrouter, (provider) => {
        provider.package = "@opencode/ai/providers/openrouter"
        provider.settings = { baseURL: url, apiKey: "not-the-active-key" }
      })
      editor.models.set(Provider.ID.openrouter, [
        Model.Info.default(Provider.ID.openrouter, Model.ID.make("allowed")),
        Model.Info.default(Provider.ID.openrouter, Model.ID.make("blocked")),
      ])
      editor.models.update(Provider.ID.openrouter, Model.ID.make("allowed"), (model) => {
        model.name = "Approved model"
        model.limit.context = 123_456
      })
    })
  })
const ids = Effect.gen(function* () {
  const models = yield* Model.Service
  return (yield* models.available())
    .filter((model) => model.providerID === Provider.ID.openrouter)
    .map((model) => String(model.id))
})
const eventually = <A, R>(effect: Effect.Effect<A, never, R>, predicate: (value: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(predicate, () => new Error("Timed out waiting for OpenRouter inventory")),
    Effect.retry({ times: 300, schedule: Schedule.spaced("5 millis") }),
  )
const refresh = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const integrations = yield* Integration.Service
  const connection = yield* integrations.connection.active(Integration.ID.make("openrouter"))
  yield* bus.publish(
    Credential.Event.Switched,
    {
      integrationID: Integration.ID.make("openrouter"),
      credentialID: connection?.type === "credential" ? connection.id : null,
    },
    { global: true },
  )
})

describe("OpenRouterPlugin", () => {
  test("is registered so legacy OpenRouter behavior can be applied", () => {
    expect(ProviderPlugins.map((item) => item.id)).toContain("opencode.provider.openrouter")
  })

  it.effect("applies legacy referer headers only to openrouter", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      yield* catalog.transform((catalog) => {
        catalog.update(Provider.ID.openrouter, (provider) => {
          provider.package = "@opencode/ai/providers/openrouter"
          provider.headers = { Existing: "value" }
        })
        catalog.update(Provider.ID.make("nvidia"), () => {})
      })
      yield* addPlugin()

      expect((yield* catalog.get(Provider.ID.openrouter))?.headers).toEqual({
        Existing: "value",
        "HTTP-Referer": "https://opencode.ai/",
        "X-Title": "opencode",
      })
      expect((yield* catalog.get(Provider.ID.make("nvidia")))?.headers).toBeUndefined()
    }),
  )

  it.effect("filters OpenRouter's gpt-5 chat alias", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      const models = yield* Model.Service
      yield* catalog.transform((catalog) => {
        catalog.update(Provider.ID.openrouter, (provider) => {
          provider.package = "@opencode/ai/providers/openrouter"
        })
        catalog.update(Provider.ID.openai, () => {})
        catalog.models.update(Provider.ID.openrouter, Model.ID.make("openai/gpt-5-chat"), () => {})
        catalog.models.update(Provider.ID.openrouter, Model.ID.make("openai/gpt-5"), () => {})
        catalog.models.update(Provider.ID.openai, Model.ID.make("openai/gpt-5-chat"), () => {})
      })
      yield* addPlugin()

      expect((yield* models.get(Provider.ID.openrouter, Model.ID.make("openai/gpt-5-chat")))?.enabled).toBe(false)
      expect((yield* models.get(Provider.ID.openrouter, Model.ID.make("openai/gpt-5")))?.enabled).toBe(true)
      expect((yield* models.get(Provider.ID.openai, Model.ID.make("openai/gpt-5-chat")))?.enabled).toBe(true)
    }),
  )

  it.effect("does not disable gpt-5-chat-latest for non-OpenRouter providers", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      const models = yield* Model.Service
      yield* catalog.transform((catalog) => {
        catalog.update(Provider.ID.make("custom-openrouter"), () => {})
        catalog.models.update(Provider.ID.make("custom-openrouter"), Model.ID.make("gpt-5-chat-latest"), () => {})
      })
      yield* addPlugin()
      expect(
        (yield* models.get(Provider.ID.make("custom-openrouter"), Model.ID.make("gpt-5-chat-latest")))?.enabled,
      ).toBe(true)
    }),
  )

  it.live("uses the active key and endpoint to filter models without replacing their metadata", () =>
    Effect.gen(function* () {
      const api = yield* router(() => inventory("allowed"))
      yield* seed(api.url)
      yield* connect("secret", { baseURL: `${api.server.url.origin}/us/api/v1` })
      yield* addPlugin()
      yield* eventually(ids, (list) => list.length === 1)
      expect(yield* ids).toEqual(["allowed"])
      expect(api.requests.every((request) => new URL(request.url).pathname === "/us/api/v1/models/user")).toBe(true)
      expect(api.requests.every((request) => new URL(request.url).search === "?output_modalities=all")).toBe(true)
      expect(api.requests.every((request) => request.headers.get("authorization") === "Bearer secret")).toBe(true)
      const models = yield* Model.Service
      expect(yield* models.get(Provider.ID.openrouter, Model.ID.make("allowed"))).toMatchObject({
        name: "Approved model",
        limit: { context: 123_456 },
      })
    }),
  )

  it.live("checks configured aliases by upstream ID after provider configuration", () =>
    Effect.gen(function* () {
      const api = yield* router(() => inventory("allowed"))
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      yield* seed(api.url)
      yield* connect()
      yield* ConfigProviderPlugin.Plugin.effect(host).pipe(
        Effect.provide(
          Config.testLayer([
            new Document({
              type: "document",
              info: Schema.decodeUnknownSync(Info)({
                providers: {
                  openrouter: {
                    headers: { "HTTP-Referer": "https://company.example", "X-Custom": "value" },
                    models: {
                      approved: { modelID: "allowed" },
                      denied: { modelID: "blocked", disabled: false },
                    },
                  },
                },
              }),
            }),
          ]),
        ),
      )
      yield* addPlugin()
      yield* eventually(ids, (list) => list.includes(Model.ID.make("approved")))
      expect((yield* ids).toSorted()).toEqual(["allowed", "approved"])
      expect(api.requests[0]?.headers.get("HTTP-Referer")).toBe("https://company.example")
      expect(api.requests[0]?.headers.get("X-Custom")).toBe("value")
    }),
  )

  it.live("keeps models unavailable while the first inventory is loading", () =>
    Effect.gen(function* () {
      const response = Promise.withResolvers<Response>()
      const api = yield* router(() => response.promise)
      yield* seed(api.url)
      yield* connect()
      yield* addPlugin()
      expect(yield* ids).toEqual([])
      yield* eventually(
        Effect.sync(() => api.requests.length),
        (count) => count > 0,
      )
      expect(yield* ids).toEqual([])
      response.resolve(inventory("allowed"))
      yield* eventually(ids, (list) => list.length === 1)
    }),
  )

  it.live("treats an empty successful inventory as no available models", () =>
    Effect.gen(function* () {
      const api = yield* router(() => inventory())
      yield* seed(api.url)
      yield* connect()
      yield* addPlugin()
      yield* eventually(
        Effect.sync(() => api.requests.length),
        (count) => count > 0,
      )
      yield* Effect.promise(() => Bun.sleep(25))
      expect(yield* ids).toEqual([])
    }),
  )

  it.live("does not expose the catalog after a failed or malformed first response", () =>
    Effect.gen(function* () {
      const answer = { malformed: false }
      const api = yield* router(() =>
        answer.malformed ? Response.json({ data: [{ id: 42 }] }) : new Response("Unavailable", { status: 503 }),
      )
      yield* seed(api.url)
      yield* connect()
      yield* addPlugin()
      yield* eventually(
        Effect.sync(() => api.requests.length),
        (count) => count > 0,
      )
      yield* Effect.promise(() => Bun.sleep(25))
      expect(yield* ids).toEqual([])
      answer.malformed = true
      const count = api.requests.length
      yield* refresh
      yield* eventually(
        Effect.sync(() => api.requests.length),
        (next) => next > count,
      )
      yield* Effect.promise(() => Bun.sleep(25))
      expect(yield* ids).toEqual([])
    }),
  )

  it.live("retains a same-account inventory on a temporary failure and applies the next successful refresh", () =>
    Effect.gen(function* () {
      const answer = { status: 200, model: "allowed" }
      const api = yield* router(() =>
        answer.status === 200 ? inventory(answer.model) : new Response("Unavailable", { status: answer.status }),
      )
      yield* seed(api.url)
      yield* connect()
      yield* addPlugin()
      yield* eventually(ids, (list) => list.length === 1)
      answer.status = 503
      const count = api.requests.length
      yield* refresh
      yield* eventually(
        Effect.sync(() => api.requests.length),
        (next) => next > count,
      )
      yield* Effect.promise(() => Bun.sleep(25))
      expect(yield* ids).toEqual(["allowed"])
      answer.status = 200
      answer.model = "blocked"
      yield* refresh
      yield* eventually(ids, (list) => list.includes(Model.ID.make("blocked")))
      expect(yield* ids).toEqual(["blocked"])
    }),
  )

  it.live("hides the previous account immediately and ignores its late discovery response", () =>
    Effect.gen(function* () {
      const delayed = Promise.withResolvers<Response>()
      const api = yield* router((request) => {
        const key = request.headers.get("authorization")
        if (key === "Bearer pending") return delayed.promise
        return inventory(key === "Bearer new-account" ? "blocked" : "allowed")
      })
      yield* seed(api.url)
      yield* connect()
      yield* addPlugin()
      yield* eventually(ids, (list) => list.length === 1)
      yield* connect("pending")
      expect(yield* ids).toEqual([])
      yield* eventually(
        Effect.sync(() => api.requests.some((request) => request.headers.get("authorization") === "Bearer pending")),
        Boolean,
      )
      yield* connect("new-account")
      yield* eventually(ids, (list) => list.includes(Model.ID.make("blocked")))
      delayed.resolve(inventory("allowed"))
      yield* Effect.promise(() => Bun.sleep(25))
      expect(yield* ids).toEqual(["blocked"])
    }),
  )

  it.effect("refreshes every five minutes and expires an inventory after fifteen minutes of failures", () =>
    Effect.gen(function* () {
      const answer = { fail: false }
      const api = yield* router(() =>
        answer.fail ? new Response("Unavailable", { status: 503 }) : inventory("allowed"),
      )
      yield* seed(api.url)
      yield* connect()
      yield* addPlugin()
      yield* Effect.promise(() => Bun.sleep(50))
      expect(yield* ids).toEqual(["allowed"])
      const count = api.requests.length
      answer.fail = true
      yield* TestClock.adjust("5 minutes")
      yield* Effect.promise(() => Bun.sleep(50))
      expect(api.requests.length).toBeGreaterThan(count)
      expect(yield* ids).toEqual(["allowed"])
      yield* TestClock.adjust("10 minutes")
      yield* Effect.promise(() => Bun.sleep(50))
      expect(yield* ids).toEqual([])
      answer.fail = false
      yield* TestClock.adjust("5 minutes")
      yield* Effect.promise(() => Bun.sleep(50))
      expect(yield* ids).toEqual(["allowed"])
    }),
  )

  it.live("discovers with a configured API key when there is no saved connection", () =>
    Effect.gen(function* () {
      const api = yield* router(() => inventory("allowed"))
      yield* seed(api.url)
      const providers = yield* Provider.Service
      yield* providers.transform((editor) =>
        editor.update(Provider.ID.openrouter, (provider) => {
          provider.activation = "enabled"
        }),
      )
      yield* addPlugin()
      yield* eventually(ids, (list) => list.length === 1)
      expect(yield* ids).toEqual(["allowed"])
      expect(api.requests[0]?.headers.get("authorization")).toBe("Bearer not-the-active-key")
    }),
  )
})
