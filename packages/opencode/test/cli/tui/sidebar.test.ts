import { describe, expect, test } from "bun:test"
import * as Width from "../../../src/cli/cmd/tui/util/sidebar"

describe("clamp", () => {
  test("keeps values inside bounds", () => {
    expect(Width.clamp(42, 160)).toBe(42)
  })
  test("floors at min for legibility", () => {
    expect(Width.clamp(10, 160)).toBe(Width.Min)
  })
  test("caps wide values at max", () => {
    expect(Width.clamp(200, 400)).toBe(Width.Max)
  })
  test("reserves main pane columns on narrow terminals", () => {
    expect(Width.clamp(80, 100)).toBe(60)
  })
  test("min wins when bounds invert on tiny terminals", () => {
    expect(Width.clamp(42, 55)).toBe(Width.Min)
  })
  test("falls back on non-finite kv junk", () => {
    expect(Width.clamp(NaN, 160)).toBe(Width.Default)
    expect(Width.clamp(Infinity, 160)).toBe(Width.Default)
  })
  test("rounds fractional kv junk", () => {
    expect(Width.clamp(42.5, 160)).toBe(43)
  })
})

describe("resolve", () => {
  test("defaults when unconfigured", () => {
    expect(Width.resolve(undefined, 160)).toBe(Width.Default)
  })
  test("honors configured value", () => {
    expect(Width.resolve(60, 160)).toBe(60)
  })
  test("clamps configured value", () => {
    expect(Width.resolve(200, 400)).toBe(Width.Max)
  })
})
