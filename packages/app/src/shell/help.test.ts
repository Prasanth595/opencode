import { expect, test } from "bun:test"
import { DESKTOP_NATIVE_ENGLISH } from "@/runtime/i18n/desktop-native"
import { DESKTOP_MENU } from "./commands/desktop-menu"
import { HELP_LINKS } from "./help"

test("offers documentation, feedback, a bug report and Discord", () => {
  expect(HELP_LINKS.map((link) => link.href)).toEqual([
    "https://opencode.ai/docs",
    "https://github.com/anomalyco/opencode/issues/new?template=feature_request.yml",
    "https://github.com/anomalyco/opencode/issues/new?template=bug_report.yml",
    "https://discord.com/invite/opencode",
  ])
})

test("labels every destination with a translated string", () => {
  for (const link of HELP_LINKS) expect(DESKTOP_NATIVE_ENGLISH[link.labelKey]).toBeString()
})

test("points at the same destinations as the desktop menu bar's Help group", () => {
  const help = DESKTOP_MENU.find((menu) => menu.id === "help")

  const menuBar = (help?.items ?? []).flatMap((item) =>
    item.type === "item" && item.href && item.labelKey ? [{ label: item.labelKey, href: item.href }] : [],
  )

  // The menu bar also lists commands (export logs), which have no destination and are filtered out
  // above; the order of the two lists is allowed to differ, the set of destinations is not.
  const destinations = (links: readonly { labelKey: string; href: string }[]) =>
    links.map((link) => `${link.labelKey} ${link.href}`).sort()

  expect(destinations(HELP_LINKS)).toEqual(
    destinations(menuBar.map((item) => ({ labelKey: item.label, href: item.href }))),
  )
})
