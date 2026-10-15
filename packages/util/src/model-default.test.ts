import { describe, expect, test } from "bun:test"
import { ModelDefault } from "./model-default.js"

const model = (providerID: string, id: string, free = true) => ({ providerID, id, free })
const pick = (models: ReturnType<typeof model>[]) => ModelDefault.freeOnly(models, (item) => item.free)?.id

describe("ModelDefault.freeOnly", () => {
  test("picks big-pickle when only free OpenCode models are available", () => {
    expect(pick([model("opencode", "nemotron-free"), model("opencode", "big-pickle")])).toBe("big-pickle")
  })

  test("leaves the default alone when a paid OpenCode model is available", () => {
    expect(pick([model("opencode", "gpt-5.5", false), model("opencode", "big-pickle")])).toBeUndefined()
  })

  test("leaves the default alone when another provider is available", () => {
    expect(pick([model("anthropic", "claude-sonnet-4-6", false), model("opencode", "big-pickle")])).toBeUndefined()
    expect(pick([model("custom", "free-local"), model("opencode", "big-pickle")])).toBeUndefined()
  })

  test("leaves the default alone when big-pickle is unavailable", () => {
    expect(pick([model("opencode", "nemotron-free")])).toBeUndefined()
    expect(pick([])).toBeUndefined()
  })
})
