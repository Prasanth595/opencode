import { expect, test } from "@playwright/test"
import { project } from "../utils/app"
import { openDraft } from "../utils/workspace"

test.use({ viewport: { width: 1280, height: 900 } })

const directories = ["C:/OpenCode/HoverAlpha", "C:/OpenCode/HoverBeta", "C:/OpenCode/HoverGamma"]

async function openDraftWithProjects(page: import("@playwright/test").Page) {
  await openDraft(page, {
    name: "HoverAlpha",
    directory: directories[0],
    projects: directories.map((directory, index) => project({ id: `proj_hover_${index}`, directory })),
    seed: { projects: { local: directories.map((worktree, index) => ({ worktree, expanded: index === 0 })) } },
  })

  const trigger = page.locator('[data-component="new-session"] [data-action="prompt-project"]')
  await trigger.click()
  const menu = page.locator("#prompt-project-menu")
  await expect(menu).toBeVisible()

  return { menu, search: menu.locator('input[placeholder="Search projects"]') }
}

test("hovering project options never steals focus from the search input", async ({ page }) => {
  const { menu, search } = await openDraftWithProjects(page)
  await expect(search).toBeFocused()

  // Records every focus target while the menu is open. Only the search input may take focus;
  // each steal restarts the caret blink in the input, which reads as a flash while hovering.
  await page.evaluate(() => {
    const log: string[] = []
    const input = document.querySelector("#prompt-project-menu input")

    ;(window as unknown as { __focusLog: string[] }).__focusLog = log
    document.addEventListener(
      "focusin",
      (event) => {
        const target = event.target as HTMLElement | null
        const key = target?.getAttribute("data-option-key")

        log.push(key ? `option:${key}` : target === input ? "search" : target?.tagName ?? "unknown")
      },
      { capture: true },
    )
  })

  for (const label of ["HoverAlpha", "HoverBeta", "HoverGamma"]) {
    await menu.locator("[data-option-key]", { hasText: label }).hover({ steps: 5 })
    await page.waitForTimeout(60)
  }

  await expect(search).toBeFocused()
  const focusLog = await page.evaluate(() => (window as unknown as { __focusLog: string[] }).__focusLog)
  expect(focusLog.filter((entry) => entry !== "search")).toEqual([])
})

test("hovering a project option still tracks the highlight and the active descendant", async ({ page }) => {
  const { menu, search } = await openDraftWithProjects(page)
  const beta = menu.locator("[data-option-key]", { hasText: "HoverBeta" })

  await beta.hover({ steps: 5 })

  await expect(beta).toHaveClass(/bg-v2-overlay-simple-overlay-hover/)
  const active = await search.getAttribute("aria-activedescendant")
  expect(active).toBe(await beta.getAttribute("data-option-key"))

  // Search-as-you-type keeps working after a hover: only HoverGamma matches.
  await search.fill("gamma")
  await expect(menu.locator("[data-option-key]")).toHaveCount(2)
  await expect(menu.locator("[data-option-key]", { hasText: "HoverGamma" })).toHaveCount(1)
})
