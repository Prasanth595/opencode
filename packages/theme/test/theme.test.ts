import { expect, test } from "bun:test"
import { migrateV1, resolveThemeDocument } from "../src/tui/index.js"
import type { ThemeV1Json } from "../src/tui/v1.js"

const source: ThemeV1Json = await Bun.file(
  new URL("../../tui/src/theme/assets/opencode.json", import.meta.url),
).json()
const document = migrateV1(source)

test.each(["light", "dark"] as const)("resolves %s themes without status tokens", (mode) => {
  const theme = resolveThemeDocument(document, mode)
  expect("status" in theme.text).toBeFalse()
  expect(theme.hue.accent[800]).toBeDefined()
  expect(theme.hue.interactive[800]).toBeDefined()
})

test("defaults the dialog backdrop to the legacy scrim", () => {
  const theme = resolveThemeDocument(document, "dark")
  expect(theme.background.backdrop.a).not.toBe(0)
  const legacy = {
    ...document,
    base: { ...document.base, background: { ...document.base.background, backdrop: "#00000096" } },
  }
  expect(theme.background.backdrop.equals(resolveThemeDocument(legacy, "dark").background.backdrop)).toBeTrue()
})

test("honors a transparent dialog backdrop in custom themes", () => {
  const custom = {
    ...document,
    base: { ...document.base, background: { ...document.base.background, backdrop: "transparent" } },
  }
  const theme = resolveThemeDocument(custom, "dark")
  expect(theme.background.backdrop.a).toBe(0)
})
