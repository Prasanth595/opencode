import { expect, test } from "bun:test"
import { TokenUsage } from "../src/token-usage.js"

test("totals every token category", () => {
  expect(TokenUsage.total({ input: 1, output: 2, reasoning: 4, cache: { read: 8, write: 16 } })).toBe(31)
})

test("supports zero and large usage totals without rounding", () => {
  expect(TokenUsage.total({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })).toBe(0)
  expect(
    TokenUsage.total({
      input: 1_000_000_000,
      output: 2_000_000_000,
      reasoning: 3,
      cache: { read: 4_000_000_000, write: 5 },
    }),
  ).toBe(7_000_000_008)
})

test("measures context from the provider prompt when one is reported", () => {
  const tokens = { input: 98_586, output: 105_561, reasoning: 0, cache: { read: 98_590, write: 0 } }
  expect(TokenUsage.prompt(tokens)).toBe(197_176)
  expect(TokenUsage.context(tokens)).toBe(302_737)
  expect(TokenUsage.prompt({ ...tokens, prompt: 142 })).toBe(142)
  expect(TokenUsage.context({ ...tokens, prompt: 142 })).toBe(105_703)
})
