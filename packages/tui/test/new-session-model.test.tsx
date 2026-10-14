import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = {
  id: "ses_model",
  title: "Session with model",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

function render(state: string, config: Record<string, unknown>) {
  return createAppFixture({
    state,
    args: { sessionID: session.id },
    config,
    fetch: (url) => {
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            { id: "other", providerID: "provider", name: "Other Model", variants: [] },
            { id: "model", providerID: "provider", name: "Session Model", variants: [] },
          ],
        })
    },
  })
}

test("/new keeps the last used model by default", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path, { animations: false, tabs: { mode: "on" } })

  await setup.waitForFrame((frame) => frame.includes("Session with model"))
  await setup.mockInput.typeText("/new")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes("New session"))

  expect(frame).toContain("Session Model")
})

test("/new uses the first available model when new_model is default", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path, {
    animations: false,
    tabs: { mode: "on" },
    session: { new_model: "default" },
  })

  await setup.waitForFrame((frame) => frame.includes("Session with model"))
  await setup.mockInput.typeText("/new")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes("New session") && frame.includes("Other Model"))

  expect(frame).toContain("Other Model")
})
