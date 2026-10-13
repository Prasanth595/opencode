import { expect, test } from "bun:test"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { lastRunConfig, parseModel, recentModels } from "../../src/context/local"

const user = (model: string, time: number) =>
  ({
    role: "user",
    agent: "build",
    time: { created: time },
    model: { ...parseModel(model), variant: "high" },
  }) as UserMessage

const assistant = (model: string, time: number, extra: Partial<AssistantMessage> = {}) =>
  ({
    role: "assistant",
    agent: "build",
    time: { created: time },
    ...parseModel(model),
    variant: "low",
    ...extra,
  }) as unknown as AssistantMessage

test("last run config follows the newest user message", () => {
  expect(
    lastRunConfig([user("a/one", 1), assistant("a/one", 2), user("cursor/sonnet", 3), assistant("a/one", 4)]),
  ).toEqual({
    agent: "build",
    model: { providerID: "cursor", modelID: "sonnet", variant: "high" },
    variant: "high",
  })
})

test("last run config falls back to the newest assistant message when no user message is loaded", () => {
  expect(
    lastRunConfig([
      assistant("cursor/sonnet", 1),
      assistant("cursor/sonnet", 2),
      assistant("openai/luna", 3, { summary: true, agent: "compaction" }),
    ]),
  ).toEqual({
    agent: "build",
    model: { providerID: "cursor", modelID: "sonnet" },
    variant: "low",
  })
  expect(lastRunConfig([])).toBeUndefined()
})

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})
