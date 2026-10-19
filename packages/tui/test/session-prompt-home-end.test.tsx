import { expect, test } from "bun:test"
import { ScrollBoxRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import type { SessionInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const LAST = 39

test("Home and End move the prompt cursor instead of the transcript", async () => {
  await using state = await tmpdir()
  await using setup = await fixture(state.path)
  const prompt = await ready(setup)
  const history = transcript(setup)
  const top = history.scrollTop

  await setup.mockInput.typeText("hello world")
  setup.mockInput.pressKey("HOME")
  await setup.mockInput.typeText("x")
  setup.mockInput.pressKey("END")
  await setup.mockInput.typeText("y")
  await setup.flush()

  expect(prompt.plainText).toBe("xhello worldy")
  expect(history.scrollTop).toBe(top)
})

test("the prompt keeps transcript jumps on their remaining keys", async () => {
  await using state = await tmpdir()
  await using setup = await fixture(state.path)
  await ready(setup)
  const history = transcript(setup)
  const bottom = () => history.scrollHeight - history.viewport.height
  expect(history.scrollTop).toBe(bottom())

  setup.mockInput.pressKey("g", { ctrl: true })
  await setup.waitFor(() => history.scrollTop === 0)
  expect(history.scrollTop).toBe(0)

  setup.mockInput.pressKey("g", { ctrl: true, meta: true })
  await setup.waitFor(() => history.scrollTop === bottom())
  expect(history.scrollTop).toBe(bottom())
})

async function fixture(state: string) {
  const session = {
    id: `ses_home_end_${crypto.randomUUID()}`,
    title: "Home and End fixture",
    projectID: "proj_home_end",
    location: { directory },
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: LAST },
  } satisfies SessionInfo
  const location = { directory, project: { id: session.projectID, directory, canonical: directory } }
  const setup = await createAppFixture({
    width: 100,
    height: 30,
    state,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { enabled: false }, session: { sidebar: "hide" } },
    fetch: async (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "fixture", name: "Model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "fixture", name: "Fixture" }] })
      if (url.pathname === "/api/vcs")
        return json({ location, data: { branch: { current: "fixture", default: "dev" } } })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({
          data: Array.from({ length: LAST + 1 }, (_, index) => ({
            id: messageID(index),
            type: "user",
            text: `Transcript item ${String(index).padStart(2, "0")}`,
            time: { created: index + 1 },
          })).toReversed(),
          cursor: {},
        })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/form`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/prompt`) return json({ data: {} })
      return undefined
    },
  })
  return setup
}

async function ready(setup: Awaited<ReturnType<typeof fixture>>) {
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes(`Transcript item ${LAST}`) && frame.includes("Build · Model"), {
    maxPasses: 120,
  })
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  return setup.renderer.currentFocusedEditor as TextareaRenderable
}

function messageID(index: number) {
  return `msg_home_${String(index).padStart(2, "0")}`
}

function transcript(setup: Awaited<ReturnType<typeof fixture>>) {
  let item: Renderable | null | undefined = setup.renderer.root.findDescendantById(messageID(LAST))
  while (item && !(item instanceof ScrollBoxRenderable)) item = item.parent
  if (!(item instanceof ScrollBoxRenderable))
    throw new Error(`Missing transcript scrollbox\n${setup.captureCharFrame()}`)
  return item
}
