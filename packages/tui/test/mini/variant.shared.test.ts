import { describe, expect, test } from "bun:test"
import {
  cycleVariant,
  formatModelLabel,
  pickVariant,
  resolveVariant,
  selectVariant,
} from "../../src/mini/variant.shared"
import type { RunSession } from "../../src/mini/session.shared"
import type { RunProvider } from "../../src/mini/types"

const model = {
  providerID: "openai",
  modelID: "gpt-5",
}

const providers: RunProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5": {
        name: "GPT-5",
      },
    },
  },
]

describe("run variant shared", () => {
  test("prefers cli then session then saved variants", () => {
    expect(resolveVariant("max", "high", "low", ["low", "high"])).toBe("max")
    expect(resolveVariant("default", "high", "low", ["low", "high"])).toBeUndefined()
    expect(resolveVariant(undefined, "high", "low", ["low", "high"])).toBe("high")
    expect(resolveVariant(undefined, "missing", "low", ["low", "high"])).toBe("low")
  })

  test("cycles through variants and back to default", () => {
    expect(cycleVariant(undefined, ["low", "high"])).toBe("low")
    expect(cycleVariant("default", ["low", "high"])).toBe("low")
    expect(cycleVariant("low", ["low", "high"])).toBe("high")
    expect(cycleVariant("high", ["low", "high"])).toBeUndefined()
    expect(cycleVariant(undefined, [])).toBeUndefined()
  })

  test("formats model labels", () => {
    expect(formatModelLabel(model, undefined)).toBe("gpt-5 · openai")
    expect(formatModelLabel(model, "high")).toBe("gpt-5 · openai · high")
    expect(formatModelLabel(model, undefined, providers)).toBe("GPT-5 · OpenAI")
    expect(formatModelLabel(model, "high", providers)).toBe("GPT-5 · OpenAI · high")
  })

  test("cycles reasoning without changing the selected context window", () => {
    const variants = [
      "low",
      "high",
      "default@default",
      "low@default",
      "high@default",
      "default@long",
      "low@long",
      "high@long",
    ]
    expect(cycleVariant("low@long", variants, true)).toBe("high@long")
    expect(cycleVariant("high@long", variants, true)).toBe("default@long")
    expect(cycleVariant("default@long", variants, true)).toBe("low@long")
    expect(cycleVariant(undefined, variants, true)).toBe("low@default")
    expect(selectVariant("low@long", "high", true)).toBe("high@long")
    expect(selectVariant("high@long", undefined, true)).toBe("default@long")
    expect(selectVariant("high@long", "low@default", true)).toBe("low@default")
    expect(selectVariant("high", "low", false)).toBe("low")
    expect(cycleVariant("high@long", [...variants, "custom@v2", "custom@v2@long"], true)).toBe("custom@v2@long")
    expect(cycleVariant(undefined, ["high", "default@long"])).toBe("high")
    expect(selectVariant("default@long", "high", false)).toBe("high")
    expect(
      formatModelLabel(
        model,
        "high@long",
        providers.map((provider) => ({
          ...provider,
          models: { "gpt-5": { name: "GPT-5", context: { default: 272_000, long: 922_000 } } },
        })),
      ),
    ).toBe("GPT-5 · OpenAI · high · long context")
  })

  test("picks the latest matching variant from session history", () => {
    const session: RunSession = {
      first: false,
      turns: [
        { prompt: { text: "one", parts: [] }, provider: "openai", model: "gpt-5", variant: "high" },
        { prompt: { text: "two", parts: [] }, provider: "anthropic", model: "sonnet", variant: "max" },
        { prompt: { text: "three", parts: [] }, provider: "openai", model: "gpt-5", variant: "minimal" },
      ],
    }

    expect(pickVariant(model, session)).toBe("minimal")
  })
})
