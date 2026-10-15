import { describe, expect, test } from "bun:test"
import { ModelDefault } from "./model-default.js"

describe("ModelDefault.pick", () => {
  test("prefers a priority model over earlier unranked models", () => {
    expect(ModelDefault.pick([{ id: "nemotron-free" }, { id: "big-pickle" }])?.id).toBe("big-pickle")
  })

  test("prefers later priority entries", () => {
    expect(ModelDefault.pick([{ id: "gpt-5.5" }, { id: "claude-sonnet-4-6" }, { id: "big-pickle" }])?.id).toBe(
      "big-pickle",
    )
  })

  test("keeps the caller's order among equally ranked models", () => {
    expect(ModelDefault.pick([{ id: "gpt-5.6-sol" }, { id: "gpt-5.5" }])?.id).toBe("gpt-5.6-sol")
    expect(ModelDefault.pick([{ id: "kimi-k3" }, { id: "glm-6" }])?.id).toBe("kimi-k3")
  })

  test("returns undefined for an empty list", () => {
    expect(ModelDefault.pick([])).toBeUndefined()
  })
})
