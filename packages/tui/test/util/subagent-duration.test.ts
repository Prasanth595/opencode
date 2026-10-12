import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { subagentDuration } from "../../src/util/subagent-duration"

const minute = 60_000
const start = 1_000_000
const state: Extract<ToolPart["state"], { status: "completed" }> = {
  status: "completed",
  input: {},
  output: "done",
  title: "Task",
  metadata: {},
  time: { start: start + 135 * minute, end: start + 143 * minute + 5_000 },
}

describe("subagentDuration", () => {
  test("excludes earlier turns and idle time in a resumed child session", () => {
    expect(
      subagentDuration(state, [
        { role: "user", time: { created: start } },
        { role: "assistant", time: { created: start, completed: start + minute } },
        { role: "user", time: { created: state.time.start } },
        { role: "assistant", time: { created: state.time.start, completed: state.time.end } },
      ]),
    ).toBe(8 * minute + 5_000)
  })

  test("does not change an old task's duration when the child is reused later", () => {
    expect(
      subagentDuration(state, [
        { role: "user", time: { created: start } },
        { role: "assistant", time: { created: start, completed: state.time.end + 60 * minute } },
      ]),
    ).toBe(8 * minute + 5_000)
  })

  test("uses the tool clock even if the child message page is empty or truncated", () => {
    expect(subagentDuration(state, [])).toBe(8 * minute + 5_000)
    expect(
      subagentDuration(state, [{ role: "assistant", time: { created: state.time.start, completed: state.time.end } }]),
    ).toBe(8 * minute + 5_000)
  })

  test("keeps background timing based on the child rather than the immediate tool return", () => {
    expect(
      subagentDuration({ ...state, metadata: { background: true }, time: { start, end: start + 10 } }, [
        { role: "user", time: { created: start } },
        { role: "assistant", time: { created: start, completed: start + 8 * minute + 5_000 } },
      ]),
    ).toBe(8 * minute + 5_000)
  })

  test("returns zero for a background task with no completed child response", () => {
    expect(subagentDuration({ ...state, metadata: { background: true } }, [])).toBe(0)
  })
})
