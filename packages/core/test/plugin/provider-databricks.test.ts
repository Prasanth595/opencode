import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { DatabricksPlugin } from "@opencode/core/plugin/provider/databricks"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const providerID = Provider.ID.make("databricks")

describe("DatabricksPlugin", () => {
  it.effect("declares Anthropic cache breakpoints for Claude models only", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const providers = yield* Provider.Service
      const models = yield* Model.Service
      yield* providers.transform((editor) => {
        editor.update(providerID, (provider) => {
          provider.activation = "enabled"
          provider.package = "@opencode/ai/providers/openai-compatible"
          provider.settings = { baseURL: "https://dbc.example.com/ai-gateway/mlflow/v1" }
        })
        editor.models.update(providerID, Model.ID.make("databricks-claude-sonnet-4-6"), () => {})
        editor.models.update(providerID, Model.ID.make("databricks-llama-4-maverick"), () => {})
      })
      yield* DatabricksPlugin.effect(yield* PluginHost.make(plugin))

      const claude = yield* models.get(providerID, Model.ID.make("databricks-claude-sonnet-4-6"))
      const llama = yield* models.get(providerID, Model.ID.make("databricks-llama-4-maverick"))
      expect(claude?.compatibility).toEqual({ cacheFormat: "anthropic" })
      expect(llama?.compatibility?.cacheFormat).toBeUndefined()
      if (!claude) throw new Error("Expected the Claude model")
      expect((yield* ModelResolver.fromCatalogModel(claude)).compatibility?.cacheFormat).toBe("anthropic")
    }),
  )
})
