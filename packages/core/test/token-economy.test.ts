import { describe, expect, it } from "bun:test"
import { Message, ToolResultPart } from "@opencode/ai"
import { repair } from "@opencode/core/tool/input-repair"
import { headTail } from "@opencode/core/tool/preview"
import { mainContent } from "@opencode/core/tool/main-content"
import { dedupe } from "@opencode/core/session/runner/dedupe-tool-results"
import { promptCacheKey } from "@opencode/core/session/runner/cache-key"

describe("token economy", () => {
  it("repairs JSON-object arguments", () => {
    expect(repair('{"path":"a"}', { type: "object", properties: { path: { type: "string" } } })).toEqual({ path: "a" })
  })
  it("converts only schema-declared scalars", () => {
    expect(repair({ offset: "15", line: "15", enabled: "true" }, { type: "object", properties: { offset: { type: "integer" }, enabled: { type: "boolean" } } })).toEqual({ offset: 15, line: "15", enabled: true })
  })
  it("rejects unsafe numeric coercion", () => {
    const value = { offset: "9007199254740993" }
    expect(repair(value, { type: "object", properties: { offset: { type: "integer" } } })).toBe(value)
  })
  it("preserves required null so validation still rejects it", () => {
    const value = { path: null }
    expect(repair(value, { type: "object", properties: { path: { type: "string" } }, required: ["path"] })).toBe(value)
  })
  it("preserves null from union-shaped optional schema", () => {
    const value = { choice: null, count: "4" }
    expect(repair(value, { type: "object", properties: { choice: { anyOf: [{ type: "null" }, { type: "string" }] }, count: { type: "integer" } } })).toEqual({ choice: null, count: 4 })
  })
  it("keeps beginning and end with bounded bytes", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line-${i} ${"x".repeat(40)}`).join("\n")
    const output = headTail(text, 20, 1024, "/tmp/full")!
    expect(output).toContain("line-99")
  })
  it("never exceeds configured preview budget", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line-${i} ${"x".repeat(40)}`).join("\n")
    expect(Buffer.byteLength(headTail(text, 20, 1024, "/tmp/full")!, "utf8")).toBeLessThanOrEqual(1024)
  })
  it("extracts primary content without navigation", () => {
    expect(mainContent('<nav>Ignore</nav><main><h1>Keep</h1></main><footer>Ignore</footer>')).toBe('<main><h1>Keep</h1></main>')
  })
  it("falls back safely if no main exists", () => {
    expect(mainContent('<body><h1>Keep</h1></body>')).toBe('<body><h1>Keep</h1></body>')
  })
  it("isolates one-off cache keys from the primary session", () => {
    expect(promptCacheKey("session-a", "compaction")).not.toBe(promptCacheKey("session-a", "primary"))
  })
  it("retains the original primary cache key", () => {
    expect(promptCacheKey("session-a", "primary")).toBe("session-a")
  })
  it("retains the latest exact read result and elides earlier duplicates", () => {
    const content = "repeat".repeat(500)
    const tool = (id: string) => Message.tool(ToolResultPart.make({ id, name: "read", result: { type: "text", value: content } }))
    const result = dedupe([tool("one"), tool("two")])
    expect(result[1]?.content[0]).toMatchObject({ result: { value: content } })
  })
  it("does not elide unique or short results", () => {
    const tool = (id: string, content: string) => Message.tool(ToolResultPart.make({ id, name: "read", result: { type: "text", value: content } }))
    const results = dedupe([tool("one", "abc"), tool("two", "abc")])
    expect(results[0]?.content[0]).toMatchObject({ result: { value: "abc" } })
  })
  it("does not mutate persisted tool messages", () => {
    const content = "repeat".repeat(500)
    const original = Message.tool(ToolResultPart.make({ id: "one", name: "read", result: { type: "text", value: content } }))
    dedupe([original, original])
    expect(original.content[0]).toMatchObject({ result: { value: content } })
  })
})
