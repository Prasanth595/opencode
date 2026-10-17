import { expect, test } from "bun:test"
import { type Renderable, ScrollBoxRenderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const session = {
  id: `ses_scrollbar_${crypto.randomUUID()}`,
  title: "Scrollbar default fixture",
  projectID: "proj_scrollbar",
  location: { directory },
  agent: "build",
  model: { providerID: "fixture", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 12 },
} as const
const location = { directory, project: { id: session.projectID, directory, canonical: directory } }
const messages = Array.from({ length: 24 }, (_, index) => ({
  id: `msg_scrollbar_${index}`,
  type: "user",
  text: `Scroll through the transcript, item ${index}`,
  time: { created: index + 1 },
})).toReversed()

function sessionScrollbox(root: Renderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable && root.getRenderable(messages[0].id)) return root
  return root.getChildren().map(sessionScrollbox).find(Boolean)
}

test("session transcript scrollbar is visible by default", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    width: 120,
    height: 30,
    state: state.path,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { enabled: false }, session: { sidebar: "hide" } },
    fetch: async (url) => {
      if (url.pathname === "/api/location") return json({ location })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "fixture", name: "Model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "fixture", name: "Fixture" }] })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages, cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/form`) return json({ data: [] })
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("item 23"), { maxPasses: 120 })
  const scroll = sessionScrollbox(setup.renderer.root)
  if (!scroll) throw new Error("Session scrollbox not found")
  // With no session.scrollbar config the transcript shows its scrollbar.
  expect(scroll.verticalScrollBar.visible).toBe(true)
})
