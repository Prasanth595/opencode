import { describe, expect, test } from "bun:test"
import {
  cycleVariant,
  formatModelLabel,
  pickVariant,
  resolveVariant,
  selectVariant,
  fitVariant,
  variantOptions,
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
    const variants = ["low", "high"]
    expect(cycleVariant("low@long", variants, true)).toBe("high@long")
    expect(cycleVariant("high@long", variants, true)).toBe("default@long")
    expect(cycleVariant("default@long", variants, true)).toBe("low@long")
    expect(cycleVariant(undefined, variants, true)).toBe("low@default")
    expect(selectVariant("low@long", "high", true)).toBe("high@long")
    expect(selectVariant("high@long", undefined, true)).toBe("default@long")
    expect(selectVariant("high@long", "low@default", true)).toBe("low@default")
    expect(selectVariant("high", "low", false)).toBe("low")
    expect(cycleVariant("high@long", [...variants, "custom@v2"], true)).toBe("custom@v2@long")
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

  test("retains context preferences against reasoning-only catalogs and builds local picker options", () => {
    const variants = ["low", "high", "custom@v2"]
    expect(resolveVariant(undefined, "high@long", "low", variants, true)).toBe("high@long")
    expect(resolveVariant(undefined, undefined, "custom@v2@long", variants, true)).toBe("custom@v2@long")
    expect(resolveVariant(undefined, "unknown@long", "default@long", variants, true)).toBe("default@long")
    expect(fitVariant("unknown@long", [], true)).toBeUndefined()
    expect(fitVariant("default@long", [], true)).toBe("default@long")
    expect(fitVariant("high@long", variants)).toBeUndefined()
    expect(variantOptions(variants, true)).toEqual([
      ...variants,
      "default@default",
      "low@default",
      "high@default",
      "custom@v2@default",
      "default@long",
      "low@long",
      "high@long",
      "custom@v2@long",
    ])
    expect(variantOptions([], true)).toEqual(["default@default", "default@long"])
  })

  test("cycles real suffix-named efforts and preserves their identity across context choices", () => {
    const variants = ["high", "explicit@long"]
    expect(cycleVariant("high@default", variants, true)).toBe("explicit@long@default")
    expect(cycleVariant("explicit@long@default", variants, true)).toBe("default@default")
    expect(cycleVariant("explicit@long", variants, true)).toBe("default@long")
    expect(selectVariant("high@default", "explicit@long", true, variants)).toBe("explicit@long@default")
    expect(selectVariant("explicit@long@default", "explicit@long@long", true, variants)).toBe("explicit@long@long")
    expect(fitVariant("explicit@long@default", variants, true)).toBe("explicit@long@default")
    expect(fitVariant("unknown@long@default", variants, true)).toBeUndefined()
    expect(variantOptions(variants, true)).toContain("explicit@long@default")
    expect(variantOptions(variants, true)).toContain("explicit@long@long")
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
