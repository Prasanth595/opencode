/**
 * The support destinations the in-app Help menu offers, in the order it lists them.
 *
 * The labels are the ones the desktop menu bar's Help group already ships in every locale
 * (`runtime/i18n/desktop-native.ts`), and the hrefs are the ones that group uses
 * (`shell/commands/desktop-menu.ts`) — so the two menus stay on the same destinations instead of
 * drifting apart. `desktop.menu.exportLogs` is deliberately left out: it runs a command rather than
 * opening a destination, so it does not belong in this menu. `help.test.ts` asserts the two lists
 * agree.
 */
export const HELP_LINKS = [
  { labelKey: "desktop.menu.documentation", href: "https://opencode.ai/docs" },
  {
    labelKey: "desktop.menu.shareFeedback",
    href: "https://github.com/anomalyco/opencode/issues/new?template=feature_request.yml",
  },
  {
    labelKey: "desktop.menu.reportBug",
    href: "https://github.com/anomalyco/opencode/issues/new?template=bug_report.yml",
  },
  { labelKey: "desktop.menu.supportForum", href: "https://discord.com/invite/opencode" },
] as const
