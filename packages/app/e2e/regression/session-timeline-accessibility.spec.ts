import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, shell, textPart, userMessage } from "../utils/timeline"

test("space activates a focused timeline button instead of scrolling", async ({ page }) => {
  const shellID = "prt_space_button_shell"
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        shell(shellID, "completed", lines(5)),
        textPart(
          "prt_space_following",
          "Following content leaves room to focus the command away from the bottom. ".repeat(40),
        ),
      ]),
    ],
    settings: { shellToolPartsExpanded: false },
    reducedMotion: true,
    seedHistory: true,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const trigger = page.getByRole("button", { name: "Used 1 Shell", exact: true })
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(300)
  await trigger.scrollIntoViewIfNeeded()
  await scroller.hover()
  await page.mouse.wheel(0, -100)
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeGreaterThan(50)
  await expect(trigger).toBeInViewport()
  await trigger.focus()
  await expect(trigger).toBeFocused()
  const before = await scroller.evaluate((element) => element.scrollTop)
  await trigger.press("Space")
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before)
})

test("jump to latest is reachable only while it is shown", async ({ page }) => {
  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_jump_latest_text", "Latest response.")])],
    seedHistory: true,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const jump = page.getByRole("button", { name: "Jump to latest", exact: true })
  const latest = page.getByText("Latest response.", { exact: true })
  await expect(latest).toBeInViewport()
  await jump.focus()
  await expect(jump).not.toBeFocused()

  await scroller.hover()
  await page.mouse.wheel(0, -3000)
  await expect(latest).not.toBeInViewport()
  await jump.click()
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(1)
  await expect(latest).toBeInViewport()
  // The click focused the button; hiding it must not leave focus on an invisible control.
  await expect(jump).not.toBeFocused()
})

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}
