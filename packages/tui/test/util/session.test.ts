import { describe, expect, test } from "bun:test"
import type { ModelInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { contextUsage, formatSessionCost, lastAssistantWithUsage, sessionFamily } from "../../src/util/session"
import { contextSelection } from "../../src/util/context"

const assistant = (id: string, input: number): SessionMessageAssistant => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [],
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0 },
})

describe("util.session", () => {
  test("uses the response context tier and formats complete Copilot costs in credits", () => {
    const model: ModelInfo = {
      id: "model",
      modelID: "model",
      providerID: "github-copilot",
      name: "Test",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      context: { default: 272_000, long: 922_000 },
    }
    const message = {
      ...assistant("msg", 31_595),
      model: { id: "model", providerID: "github-copilot", variant: "medium@default" },
      cost: 0.083,
    }
    expect(contextUsage([message], [model])?.percent).toBe(8)
    expect(contextUsage([{ ...message, model: { ...message.model, variant: "high@long" } }], [model])?.percent).toBe(3)
    expect(formatSessionCost(0.083, [message])).toBe("8.30 AI credits")
    expect(formatSessionCost(0.1, [message])).toBe("$0.10")
    expect(formatSessionCost(0.083, [{ ...message, model: { ...message.model, providerID: "openai" } }])).toBe("$0.08")
    expect(contextSelection("high@long")).toEqual({ effort: "high", tier: "long" })
    expect(contextSelection("medium")).toEqual({ effort: "medium", tier: "default" })
    expect(contextUsage([message], [{ ...model, limit: { ...model.limit, input: 100_000 } }])?.percent).toBe(14)
  })
  test("includes compaction providers when choosing the session cost unit", () => {
    const message = { ...assistant("msg", 10), model: { id: "model", providerID: "github-copilot" }, cost: 0.08 }
    const compaction: SessionMessageInfo = {
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "auto",
      model: { id: "model", providerID: "openai" },
      summary: "Summary",
      recent: "",
      cost: 0.02,
      time: { created: 0 },
    }
    expect(formatSessionCost(0.1, [message, compaction])).toBe("$0.10")
    expect(formatSessionCost(0.1, [message, { ...compaction, model: undefined }])).toBe("$0.10")
    expect(formatSessionCost(0.1, [message, { ...compaction, model: message.model }])).toBe("10.00 AI credits")
    expect(formatSessionCost(0.02, [compaction])).toBe("$0.02")
  })
  test("flattens nested subagents from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild-a", parentID: "child-a" },
      { id: "great-grandchild-a", parentID: "grandchild-a" },
      { id: "grandchild-a2", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "grandchild-b", parentID: "child-b" },
    ]

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })

  test("tracks usage across undo and redo boundaries", () => {
    const messages = [assistant("msg_z", 10), assistant("msg_a", 30)]

    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
    expect(lastAssistantWithUsage(messages, "msg_a")?.tokens.input).toBe(10)
    expect(lastAssistantWithUsage(messages, "msg_missing")).toBeUndefined()
    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
  })

  test("resets usage at completed compaction until the next assistant reports it", () => {
    const compaction: SessionMessageInfo = {
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "Current state",
      recent: "",
      time: { created: 0 },
    }
    const messages = [assistant("msg_before", 30), compaction]

    expect(lastAssistantWithUsage(messages)).toBeUndefined()

    messages.push(assistant("msg_after", 5))
    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(5)
  })
})
