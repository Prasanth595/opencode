import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { SessionModelRoute } from "@opencode/core/session/model-route"

const provider = Provider.ID.anthropic

function model(id: string, input: number, output = input, variants: string[] = []) {
  return {
    ...Model.Info.default(provider, Model.ID.make(id)),
    cost: [
      {
        input: Money.USDPerMillionTokens.make(input),
        output: Money.USDPerMillionTokens.make(output),
        cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
      },
    ],
    variants: variants.map((variant) => ({ id: Model.VariantID.make(variant) })),
  } satisfies Model.Info
}

describe("SessionModelRoute.lanes", () => {
  test("maps cheapest, middle, and strongest models into complexity buckets", () => {
    const catalog = [model("haiku", 1), model("sonnet", 5), model("opus", 20), model("sonnet-mid", 8)]
    expect(SessionModelRoute.lanes(catalog)).toMatchObject({
      trivial: { id: "haiku" },
      "local-edit": { id: "sonnet" },
      "multi-file": { id: "sonnet-mid" },
      architecture: { id: "opus" },
    })
  })

  test("returns nothing when no tool-capable text models are available", () => {
    const catalog = [
      {
        ...model("embed", 1),
        capabilities: { tools: false, input: ["text"], output: ["text"] },
      },
    ]
    expect(SessionModelRoute.lanes(catalog)).toBeUndefined()
  })
})

describe("SessionModelRoute.decide", () => {
  const catalog = [model("haiku", 1), model("sonnet", 5, 5, ["high"]), model("opus", 20, 20, ["max"])]

  test("selects a stronger model and reasoning variant for architecture work", () => {
    expect(
      SessionModelRoute.decide({
        complexity: "architecture",
        confidence: 0.9,
        needsReasoning: 0.9,
        catalog,
      }),
    ).toMatchObject({
      bucket: "architecture",
      model: { id: "opus", providerID: "anthropic", variant: "max" },
    })
  })

  test("keeps the current model when the bucket already matches", () => {
    expect(
      SessionModelRoute.decide({
        complexity: "trivial",
        confidence: 0.99,
        needsReasoning: 0,
        catalog,
        current: Model.Ref.make({ id: Model.ID.make("haiku"), providerID: provider }),
      }),
    ).toBeUndefined()
  })

  test("does not switch when confidence is below the threshold", () => {
    expect(
      SessionModelRoute.decide({
        complexity: "architecture",
        confidence: 0.5,
        needsReasoning: 1,
        catalog,
      }),
    ).toBeUndefined()
  })
})

describe("SessionModelRoute.shouldRoute", () => {
  test("routes unpinned root user prompts when evaluation is available", () => {
    expect(
      SessionModelRoute.shouldRoute({
        session: { modelPinned: false },
        lastMessageType: "user",
        enabled: true,
        hasEvaluation: true,
      }),
    ).toBe(true)
  })

  test("skips pinned sessions, children, and non-user promotions", () => {
    expect(
      SessionModelRoute.shouldRoute({
        session: { modelPinned: true },
        lastMessageType: "user",
        enabled: true,
        hasEvaluation: true,
      }),
    ).toBe(false)
    expect(
      SessionModelRoute.shouldRoute({
        session: { parentID: Session.ID.make("ses_parent"), modelPinned: false },
        lastMessageType: "user",
        enabled: true,
        hasEvaluation: true,
      }),
    ).toBe(false)
    expect(
      SessionModelRoute.shouldRoute({
        session: { modelPinned: false },
        lastMessageType: "synthetic",
        enabled: true,
        hasEvaluation: true,
      }),
    ).toBe(false)
  })
})
