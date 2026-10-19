import { expect, test, type Locator, type Page } from "@playwright/test"
import { tabKey } from "../utils/app"
import { fileDiff, openSession } from "../utils/workspace"
import { expectSessionTitle } from "../utils/waits"

test("review and terminal tabs follow the session tab and the terminal stays mounted", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const a = { id: "ses_side_a", title: "Alpha session" }
  const b = { id: "ses_side_b", title: "Beta session" }

  const { directory, pty } = await openSession(page, {
    name: "SidePanels",
    sessions: [a, b],
    pty: {},
    vcsDiff: Array.from({ length: 2_740 }, (_, index) =>
      fileDiff(`src/generated-${String(index).padStart(4, "0")}.ts`),
    ),
    seed: { panes: { [a.id]: { sessionWidth: 580 }, [b.id]: { sessionWidth: 520 } } },
  })

  const chat = page.locator('[data-slot="session-chat-panel"]')
  const review = page.locator('#review-panel [data-component="session-review-v2"]')
  const terminal = page.locator('[data-component="terminal"]')
  const reviewTab = page.locator("#session-side-panel-review-tab")
  const terminalTab = page.locator("#review-panel").getByRole("tab", { name: "Terminal 1", exact: true })

  const switchTab = async (title: string) => {
    await page.locator("[data-titlebar-tab-slot]", { hasText: title }).click()
    await expectSessionTitle(page, title)
  }

  await page.getByRole("button", { name: "Toggle review" }).click()
  await expect(review).toBeVisible()
  await expect(chat).toHaveCSS("width", "580px")
  await expect(reviewTab).toHaveText("Files Changed 2740")

  // The terminal opens as a tab beside review in the same strip.
  await page.keyboard.press("Control+Backquote")
  await expect(terminalTab).toHaveAttribute("aria-selected", "true")
  await expect(terminal).toBeVisible()
  await expect(review).toBeHidden()
  await expect.poll(() => pty.sockets.length).toBe(1)
  await mark(terminal)

  await switchTab(b.title)
  await expect(terminal).toBeHidden()
  await expectMarked(terminal)
  await page.getByRole("button", { name: "Toggle review" }).click()
  await expect(review).toBeVisible()
  await expect(chat).toHaveCSS("width", "520px")
  // The workspace's terminal reopens in this session's strip instead of starting another shell.
  await page.keyboard.press("Control+Backquote")
  await expect(terminalTab).toHaveAttribute("aria-selected", "true")
  await expect(terminal).toBeVisible()
  await expectMarked(terminal)

  await switchTab(a.title)
  await expect(terminal).toBeVisible()
  await expect(chat).toHaveCSS("width", "580px")
  await expectMarked(terminal)
  await reviewTab.click()
  await expect(review).toBeVisible()
  expect(pty.sockets).toHaveLength(1)
  expect(pty.created).toHaveLength(1)
  expect(pty.sockets[0]!.url.searchParams.get("location[directory]")).toBe(directory)
  expect(pty.sockets[0]!.url.searchParams.get("ticket")).toBe("e2e-ticket")
  expect(pty.tokens[0]?.headers["x-opencode-ticket"]).toBe("1")

  await terminalTab.click()
  await expect(terminal).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem("opencode.window.browser.dat:tabs.panes") ?? "{}")[key]?.review,
        tabKey(a.id),
      ),
    )
    .toBe(true)
  await page.reload()
  await expectSessionTitle(page, a.title)
  await expect(terminalTab).toHaveAttribute("aria-selected", "true")
  await expect(terminal).toBeVisible()
  await expect(chat).toHaveCSS("width", "580px")
  await reviewTab.click()
  await expect(review).toBeVisible()

  const tree = page.locator('#review-panel [data-component="file-tree-v2"]')
  await expect(tree.getByRole("button", { name: "generated-0000.ts" })).toBeVisible()
  expect(await tree.locator('[data-slot="file-tree-v2-row"]').count()).toBeLessThanOrEqual(60)
  const viewport = page.locator('#review-panel [data-slot="session-review-v2-sidebar-tree"] .scroll-view__viewport')
  await viewport.hover()
  await page.mouse.wheel(0, 100_000)
  await expect(tree.getByRole("button", { name: "generated-2739.ts" })).toBeVisible()
})

test("review content stays aligned with the side region in both directions", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })

  // A large nested branch diff; its first file is the sentinel that proves the virtualized tree stays mounted.
  const diffs = [
    fileDiff(".github/actions/setup-bun/action.yml", { additions: 7 }),
    ...Array.from({ length: 2_739 }, (_, index) =>
      fileDiff(
        `src/branch/d${String(Math.floor(index / 100)).padStart(5, "0")}/generated-${String(index).padStart(4, "0")}.ts`,
        { additions: 100, loaded: false },
      ),
    ),
  ]

  await openSession(page, { name: "SideStack", vcsDiff: diffs })
  const toggle = page.getByRole("button", { name: "Toggle review" })
  await toggle.click()
  await expect(page.locator("#review-panel")).toBeVisible()
  await expectTreeSentinel(page)

  for (const direction of ["ltr", "rtl"] as const) {
    await page.evaluate((direction) => (document.documentElement.dir = direction), direction)
    await expect.poll(() => sideContentOffset(page, direction)).toBeLessThanOrEqual(1)
  }

  await page.reload()
  await expect(page.locator("#review-panel")).toBeVisible()
  await expectTreeSentinel(page)
})

// A DOM mark survives only while the same node stays mounted.
function mark(locator: Locator) {
  return locator.evaluate((element) => element.setAttribute("data-e2e-mounted", "original"))
}

function expectMarked(locator: Locator) {
  return expect(locator).toHaveAttribute("data-e2e-mounted", "original")
}

async function expectTreeSentinel(page: Page) {
  const tree = page.locator('#review-panel [data-component="file-tree-v2"]')
  await expect(tree.getByRole("button", { name: "action.yml" })).toBeVisible()
  const rows = await tree.locator('[data-slot="file-tree-v2-row"]').count()
  expect(rows).toBeGreaterThan(0)
  expect(rows).toBeLessThanOrEqual(60)
}

function sideContentOffset(page: Page, direction: "ltr" | "rtl") {
  return page.evaluate((direction) => {
    const frame = document.querySelector('[data-slot="session-side-panel-presence"]')!.getBoundingClientRect()
    const content = document.querySelector('[data-slot="session-side-panel-content"]')!.getBoundingClientRect()

    return direction === "rtl" ? Math.abs(frame.right - content.right) : Math.abs(frame.left - content.left)
  }, direction)
}
