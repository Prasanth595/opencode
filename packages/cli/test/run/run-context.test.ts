import { describe, expect, test } from "bun:test"
import { assertRunContext } from "../../src/run/run"

describe("run session context", () => {
  test("rejects nested agent sessions unless explicitly allowed", () => {
    expect(() => assertRunContext("ses_parent", false)).toThrow("nested OpenCode session")
    expect(() => assertRunContext("ses_parent", true)).not.toThrow()
    expect(() => assertRunContext(undefined, false)).not.toThrow()
  })

  test("does not inspect process ancestors when the session environment is absent", () => {
    expect(() => assertRunContext(undefined, false)).not.toThrow()
  })
})
