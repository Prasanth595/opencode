import { Effect, FiberHandle, Schedule, Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Bus } from "../../bus.js"
import { Credential } from "../../credential.js"
import { IntegrationConnection } from "../../integration/connection.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import { define } from "@opencode/plugin/effect/plugin"

const Inventory = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })) })

export const OpenRouterPlugin = define({
  id: "opencode.provider.openrouter",
  effect: Effect.fn(function* (ctx) {
    const providers = yield* Provider.Service
    const bus = yield* Bus.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const loading = Semaphore.makeUnsafe(1)
    const discovery = yield* FiberHandle.make<void, never>()
    const expiry = yield* FiberHandle.make<void, never>()

    const input = Effect.fn("OpenRouterPlugin.input")(function* () {
      const provider = yield* providers.get(Provider.ID.openrouter)
      const connection = yield* ctx.integration.connection.active(provider?.integrationID ?? Provider.ID.openrouter)
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      const settings: Readonly<Record<string, unknown>> = {
        ...provider?.settings,
        ...credential?.metadata,
        ...(credential?.type === "key" ? credential.configuration : undefined),
      }
      const key =
        connection && !credential
          ? undefined
          : credential?.type === "key"
            ? credential.key
            : credential?.type === "oauth"
              ? credential.access
              : settings.apiKey
      return {
        connection,
        key: typeof key === "string" && key !== "" ? key : undefined,
        url: String(settings.baseURL ?? "https://openrouter.ai/api/v1")
          .replace(/\$\{([^}]+)\}/g, (placeholder, name: string) => process.env[name] ?? placeholder)
          .replace(/\/+$/, ""),
        headers: provider?.headers,
        native: provider?.package === "@opencode/ai/providers/openrouter",
      }
    })
    const loaded: {
      input: Effect.Success<ReturnType<typeof input>>
      ids?: ReadonlySet<string>
    } = { input: yield* input() }

    yield* ctx.provider.transform((evt) => {
      for (const item of evt.list()) {
        if (item.provider.package !== "@opencode/ai/providers/openrouter") continue
        evt.update(item.provider.id, (provider) => {
          provider.headers = { "HTTP-Referer": "https://opencode.ai/", "X-Title": "opencode", ...provider.headers }
        })
      }
      const source = evt.get(Provider.ID.openrouter)
      if (!source || source.provider.package !== "@opencode/ai/providers/openrouter") return
      // Keep catalog definitions intact for aliases, but bind their availability to the active account.
      evt.add({
        info: source.provider,
        models: Array.from(source.models.values()),
        sourceConnection: loaded.input.connection,
      })
    })
    yield* ctx.model.transform((models) => {
      if (loaded.input.native && (loaded.input.connection || loaded.input.key)) {
        for (const model of models.list(Provider.ID.openrouter)) {
          if (!loaded.ids?.has(model.modelID ?? model.id)) models.remove(Provider.ID.openrouter, model.id)
        }
      }
      for (const item of models.provider.list()) {
        if (item.provider.package !== "@opencode/ai/providers/openrouter") continue
        for (const modelID of [Model.ID.make("gpt-5-chat-latest"), Model.ID.make("openai/gpt-5-chat")]) {
          if (!models.get(item.provider.id, modelID)) continue
          models.update(item.provider.id, modelID, (model) => {
            // These are OpenRouter-specific OpenAI chat aliases that do not work
            // on the generic path. Keep custom providers with matching IDs untouched.
            model.enabled = false
          })
        }
      }
    })

    const rebind = () =>
      loading.withPermit(
        Effect.gen(function* () {
          const current = yield* input()
          if (
            IntegrationConnection.key(current.connection) === IntegrationConnection.key(loaded.input.connection) &&
            current.key === loaded.input.key &&
            current.url === loaded.input.url &&
            current.native === loaded.input.native &&
            JSON.stringify(current.headers) === JSON.stringify(loaded.input.headers)
          )
            return
          loaded.input = current
          loaded.ids = undefined
          yield* FiberHandle.clear(expiry)
          yield* ctx.provider.reload()
        }),
      )
    const discover = Effect.fn("OpenRouterPlugin.discover")(function* () {
      const current = loaded.input
      if (!current.native || !current.key) return
      const found = yield* http
        .execute(
          HttpClientRequest.get(`${current.url}/models/user`).pipe(
            // Omitting pagination returns the full inventory; include non-text catalog models too.
            HttpClientRequest.setUrlParam("output_modalities", "all"),
            HttpClientRequest.setHeaders(current.headers ?? {}),
            HttpClientRequest.bearerToken(current.key),
            HttpClientRequest.acceptJson,
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Inventory)),
          Effect.timeout("10 seconds"),
          Effect.map((response) => new Set<string>(response.data.map((model) => model.id))),
          // HttpClient errors contain request headers; never log the cause or the resolved API key.
          Effect.catch(() => Effect.logWarning("failed to sync OpenRouter models").pipe(Effect.as(undefined))),
        )
      if (
        !found ||
        loaded.input !== current ||
        IntegrationConnection.key(current.connection) !==
          IntegrationConnection.key(yield* ctx.integration.connection.active(Provider.ID.openrouter))
      )
        return
      loaded.ids = found
      yield* ctx.model.reload()
      yield* FiberHandle.run(
        expiry,
        Effect.sleep("15 minutes").pipe(
          Effect.andThen(() => {
            loaded.ids = undefined
            return ctx.model.reload()
          }),
        ),
      )
    })
    const refresh = () => rebind().pipe(Effect.andThen(FiberHandle.run(discovery, discover())))
    yield* bus.subscribe([Credential.Event.Switched, Credential.Event.Updated, Provider.Event.Updated]).pipe(
      Stream.filter(
        (event) =>
          (event.type === "credential.switched" && String(event.data.integrationID) === Provider.ID.openrouter) ||
          event.type === "credential.updated" ||
          event.type === "provider.updated",
      ),
      Stream.runForEach(() => refresh()),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh().pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.forkScoped)
  }),
})
