import type { Locator } from "@playwright/test"

/** Opens the side panel's "Open file" launcher tab from the strip's + menu. */
export async function openFileLauncher(panel: Locator) {
  await panel.getByRole("button", { name: "Add tab", exact: true }).click()
  await panel
    .page()
    .getByRole("menuitem", { name: /^Open file/ })
    .click()
}
