import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, userMessage } from "../utils/timeline"

// The rail navigates turns, so it needs two of them to have anything to show.
const turns = () => [
  userMessage(undefined, { id: "msg_outline_first" }),
  assistantMessage(undefined, { id: "msg_outline_first_reply", parentID: "msg_outline_first" }),
  userMessage(undefined, { id: "msg_outline_second" }),
  assistantMessage(undefined, { id: "msg_outline_second_reply", parentID: "msg_outline_second" }),
]

test("navigates the conversation from a rail on the trailing edge", async ({ page }) => {
  await setupTimeline(page, { viewport: { width: 1440, height: 900 }, messages: turns() })

  const rail = page.locator(".session-outline")
  await expect(rail).toBeVisible()
  await expect(rail.locator(".session-outline-tick")).toHaveCount(2)

  // One tick per turn, hugging the trailing edge of the conversation pane.
  const panel = page.locator('[data-slot="session-chat-panel"]')
  const [railBox, panelBox] = await Promise.all([rail.boundingBox(), panel.boundingBox()])

  if (!railBox || !panelBox) throw new Error("the outline and the chat panel must both be laid out")

  expect(railBox.x + railBox.width / 2).toBeGreaterThan(panelBox.x + panelBox.width / 2)

  // Hovering a tick shows that turn's prompt.
  await rail.locator(".session-outline-tick").first().hover()
  await expect(rail.locator(".session-outline-card")).toHaveClass(/is-open/)
  await expect(rail.locator(".session-outline-title")).toHaveText("Build the timeline stability matrix.")
})
