import { expect, test, type Page } from "@playwright/test"
import { Event } from "@opencode/schema/event"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { base64Encode } from "@opencode/util/encode"
import { fixture } from "../utils/session-fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { fileNode } from "../utils/workspace"

for (const endpoint of ["/api/location", "/api/agent"]) {
  for (const recover of [false, true]) {
    test(`keeps the composer when ${endpoint} ${recover ? "recovers on retry" : "fails"}`, async ({ page }) => {
      const recovery = recoveryRequests(page)
      const directory = "/projects/working-tree"
      const sessionID = Session.ID.make("ses_location_sync_failure", { disableChecks: true })
      await mockOpenCodeServer(page, {
        directory: fixture.directory,
        project: fixture.project,
        provider: fixture.provider,
        sessions: [{ id: sessionID, projectID: fixture.project.id, directory, title: "Workspace sync" }],
        fileList: () => [],
        pageMessages: () => ({
          items: [{ id: SessionMessage.ID.make("msg_saved", { disableChecks: true }), type: "user", text: "Keep working in this worktree", time: { created: 1 } }],
        }),
      })
      let requests = 0
      await page.route("**/api/**", (route) => {
        const url = new URL(route.request().url())

        if (url.pathname !== endpoint || url.searchParams.get("location[directory]") !== directory)
          return route.fallback()
        requests++

        if (recover && requests > 1) return route.fallback()

        return route.fulfill({ status: 500, body: "", headers: { "access-control-allow-origin": "*" } })
      })

      const failure = page.waitForResponse(
        (response) => new URL(response.url()).pathname === endpoint && response.status() === 500,
      )

      const settled = page.waitForResponse((response) => {
        const url = new URL(response.url())

        return (
          url.pathname === endpoint &&
          url.searchParams.get("location[directory]") === directory &&
          (recover ? response.ok() : requests === 3 && response.status() === 500)
        )
      })

      await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
      await failure
      await expect(page.getByText("Keep working in this worktree", { exact: true })).toBeVisible()
      const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
      await expect(prompt).toBeEditable()
      await prompt.fill("Continue after reconnecting")
      await expect(prompt).toHaveText("Continue after reconnecting")
      await settled
      await expect(prompt).toBeEditable()
      await expect(prompt).toHaveText("Continue after reconnecting")
      expect(requests).toBe(recover ? 2 : 3)
      await expect(page.getByText("Session location unavailable", { exact: true })).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Choose directory", exact: true })).toHaveCount(0)
      expect(recovery).toEqual([])
      await page.screenshot({ path: test.info().outputPath("location-sync.png") })
    })
  }
}

test("replaces the composer when the location is not found and recovers by moving to another worktree", async ({
  page,
}) => {
  const directory = "/projects/deleted-worktree"
  const destination = "/projects/existing-worktree"
  const sessionID = Session.ID.make("ses_location_not_found", { disableChecks: true })
  const session = { id: sessionID, projectID: fixture.project.id, directory, title: "Missing location" }
  const moves: unknown[] = []
  const transport = await installSseTransport(page, { server: fixture.serverKey })
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    sessions: [session],
    fileList: () => [],
    worktrees: [{ directory: fixture.directory }, { directory: destination, strategy: "git" }],
    pageMessages: () => ({
      items: [{ id: SessionMessage.ID.make("msg_saved", { disableChecks: true }), type: "user", text: "Keep this session history", time: { created: 1 } }],
    }),
  })
  let requests = 0
  await page.route("**/api/location?**", (route) => {
    if (new URL(route.request().url()).searchParams.get("location[directory]") !== directory) return route.fallback()
    requests++

    return route.fulfill({
      status: 404,
      // SAFETY: the server's wire body for a missing Location, which the client decodes into its own error.
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- see SAFETY above
      json: { _tag: "LocationNotFoundError", location: { directory }, message: `Location not found: ${directory}` },
      headers: { "access-control-allow-origin": "*" },
    })
  })
  await page.route(`**/api/session/${sessionID}/move`, (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    moves.push(route.request().postDataJSON())

    return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
  })

  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  const status = page.getByRole("status").filter({ hasText: "Session location unavailable" })
  await expect(status).toContainText(directory)
  await expect(page.getByText("Keep this session history", { exact: true })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveCount(0)
  // A typed not-found answer is final; retrying cannot succeed until the folder changes.
  expect(requests).toBe(1)

  await transport.waitForConnection()
  await page.getByRole("button", { name: "Choose worktree", exact: true }).click()
  await page.getByRole("menuitem", { name: "existing-worktree", exact: true }).click()
  await expect.poll(() => moves).toEqual([{ directory: destination }])

  session.directory = destination
  await transport.send({
    id: Event.ID.make("evt_location_not_found_moved", { disableChecks: true }),
    type: "session.moved",
    created: 2,
    durable: { aggregateID: sessionID, seq: Event.Seq.make(1, { disableChecks: true }), version: 1 },
    data: { sessionID, location: { directory: destination }, projectID: fixture.project.id },
  })
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeEditable()
  await expect(status).toHaveCount(0)
  await expect(page.getByText("Keep this session history", { exact: true })).toBeVisible()
})

test("follows a live session move while the agent catalog is still loading", async ({ page }) => {
  const recovery = recoveryRequests(page)
  const directory = "/projects/old-tree"
  const destination = "/projects/current-tree"
  const sessionID = Session.ID.make("ses_location_moved_while_loading", { disableChecks: true })
  const session = { id: sessionID, projectID: fixture.project.id, directory, title: "Moved session" }
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { timelineDetail: { notices: { placement: "separate" } } } }),
    )
  })
  const transport = await installSseTransport(page, { server: fixture.serverKey })
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    sessions: [session],
    fileList: () => [],
    pageMessages: () => ({
      items: [{ id: SessionMessage.ID.make("msg_saved", { disableChecks: true }), type: "user", text: "Follow the session move", time: { created: 1 } }],
    }),
  })
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())

    if (url.pathname === "/api/agent" && url.searchParams.get("location[directory]") === directory) {
      requested.resolve()
      await release.promise
    }

    return route.fallback()
  })
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  await requested.promise
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toBeEditable()
  await prompt.fill("Keep this draft")
  await expect(page.getByText("Session location unavailable", { exact: true })).toHaveCount(0)
  await transport.waitForConnection()

  const resolved = page.waitForResponse((response) => {
    const url = new URL(response.url())

    return url.pathname === "/api/agent" && url.searchParams.get("location[directory]") === destination && response.ok()
  })

  session.directory = destination
  await transport.send({
    id: Event.ID.make("evt_location_moved_while_loading", { disableChecks: true }),
    type: "session.moved",
    created: 2,
    durable: { aggregateID: sessionID, seq: Event.Seq.make(1, { disableChecks: true }), version: 1 },
    data: { sessionID, location: { directory: destination }, projectID: fixture.project.id },
  })
  await resolved

  const delayed = page.waitForResponse((response) => {
    const url = new URL(response.url())

    return url.pathname === "/api/agent" && url.searchParams.get("location[directory]") === directory && response.ok()
  })

  release.resolve()
  await delayed
  await expect(prompt).toBeEditable()
  await expect(prompt).toHaveText("Keep this draft")
  await expect(page.getByText("Follow the session move", { exact: true })).toBeVisible()
  await expect(page.locator('[data-type="location-switched"]').getByText(destination, { exact: true })).toBeVisible()
  await expect(page.getByText("Session location unavailable", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Choose directory", exact: true })).toHaveCount(0)
  expect(recovery).toEqual([])
})

test("keeps the side panel's tabs and selection when the session moves", async ({ page }) => {
  const directory = "/projects/tabs-before-move"
  const destination = "/projects/tabs-after-move"
  const sessionID = Session.ID.make("ses_location_moved_tabs", { disableChecks: true })
  const session = { id: sessionID, projectID: fixture.project.id, directory, title: "Moved tabs" }
  const transport = await installSseTransport(page, { server: fixture.serverKey })
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    sessions: [session],
    fileList: () => [],
    findFiles: (input) =>
      ["README.md", "NOTES.md"]
        .filter((name) => name.startsWith(input.query))
        .map((name) => fileNode(session.directory, name)),
    fileContent: (path) => ({ type: "text", content: `contents:${session.directory}:${path}` }),
    pageMessages: () => ({
      items: [{ id: SessionMessage.ID.make("msg_saved", { disableChecks: true }), type: "user", text: "Keep my tabs", time: { created: 1 } }],
    }),
  })
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeEditable()

  const panel = page.getByRole("complementary", { name: "Review and files" })
  const files = panel.getByRole("tab", { name: /\.md$/ })
  const notes = panel.getByRole("tab", { name: "NOTES.md", exact: true })
  await page.getByRole("button", { name: "Toggle review", exact: true }).click()
  await expect(panel).toBeVisible()

  // A lost selection would fall back to the first file tab, README.md, so NOTES.md stays selected only if it carries.
  for (const name of ["README", "NOTES"]) {
    await panel.getByRole("button", { name: "Open file", exact: true }).click()
    const search = panel.getByRole("combobox", { name: "Filter files" })
    await expect(search).toBeFocused()
    await search.fill(name)
    const option = panel.getByRole("option", { name: new RegExp(`${name}\\.md`) })
    await expect(option).toBeVisible()
    await expect(search).toHaveAttribute("aria-activedescendant", (await option.getAttribute("id"))!)
    await search.press("Enter")
    const tab = panel.getByRole("tab", { name: `${name}.md`, exact: true })
    await expect(tab).toHaveAttribute("aria-selected", "true")
    // Promote the preview so opening the second file preserves both tabs.
    await tab.dblclick()
  }

  await expect(files).toHaveText(["README.md", "NOTES.md"])
  await expect(panel.getByText(`contents:${directory}:NOTES.md`, { exact: true })).toBeVisible()

  await transport.waitForConnection()

  const resolved = page.waitForResponse((response) => {
    const url = new URL(response.url())

    return (
      url.pathname === "/api/location" && url.searchParams.get("location[directory]") === destination && response.ok()
    )
  })

  session.directory = destination
  await transport.send({
    id: Event.ID.make("evt_location_moved_tabs", { disableChecks: true }),
    type: "session.moved",
    created: 2,
    durable: { aggregateID: sessionID, seq: Event.Seq.make(1, { disableChecks: true }), version: 1 },
    data: { sessionID, location: { directory: destination }, projectID: fixture.project.id },
  })
  await resolved
  await expect(page.locator('[data-type="location-switched"]').getByText(destination, { exact: true })).toBeVisible()
  await expect(files).toHaveText(["README.md", "NOTES.md"])
  await expect(notes).toHaveAttribute("aria-selected", "true")
  // The carried tab shows the file in the new directory.
  await expect(panel.getByText(`contents:${destination}:NOTES.md`, { exact: true })).toBeVisible()
})

test("refreshes a session moved during disconnection without losing the draft", async ({ page }) => {
  const recovery = recoveryRequests(page)
  const directory = "/projects/before-reconnect"
  const destination = "/projects/after-reconnect"
  const sessionID = Session.ID.make("ses_location_reconnect", { disableChecks: true })
  const session = { id: sessionID, projectID: fixture.project.id, directory, title: "Reconnected session" }
  const transport = await installSseTransport(page, { server: fixture.serverKey })
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    sessions: [session],
    fileList: () => [],
    pageMessages: () => ({
      items: [{ id: SessionMessage.ID.make("msg_saved", { disableChecks: true }), type: "user", text: "Resume in the current worktree", time: { created: 1 } }],
    }),
  })
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toBeEditable()
  await prompt.fill("Draft before disconnect")
  const connection = await transport.waitForConnection()

  const resolved = page.waitForResponse((response) => {
    const url = new URL(response.url())

    return (
      url.pathname === "/api/location" && url.searchParams.get("location[directory]") === destination && response.ok()
    )
  })

  session.directory = destination
  await transport.close()
  await transport.waitForConnection({ after: connection.id })
  await resolved
  await expect(prompt).toBeEditable()
  await expect(prompt).toHaveText("Draft before disconnect")
  await expect(page.getByText("Resume in the current worktree", { exact: true })).toBeVisible()
  await expect(page.getByText("Session location unavailable", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Choose directory", exact: true })).toHaveCount(0)
  expect(recovery).toEqual([])
})

test("ignores an old failed location read after reconnecting", async ({ page }) => {
  const recovery = recoveryRequests(page)
  const directory = "/projects/reconnected-tree"
  const sessionID = Session.ID.make("ses_location_stale_response", { disableChecks: true })
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const transport = await installSseTransport(page, { server: fixture.serverKey })
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    sessions: [{ id: sessionID, projectID: fixture.project.id, directory }],
    fileList: () => [],
    pageMessages: () => ({ items: [] }),
  })
  let requests = 0
  await page.route("**/api/location?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("location[directory]") !== directory) return route.fallback()
    requests++

    if (requests > 1) return route.fallback()
    requested.resolve()
    await release.promise

    return route.fulfill({
      status: 500,
      body: "",
      headers: { "access-control-allow-origin": "*" },
    })
  })
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  await requested.promise
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toBeEditable()
  await prompt.fill("Keep typing here")
  const connection = await transport.waitForConnection()
  const metadata = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/session/${sessionID}`)

  const resolved = page.waitForResponse((response) => {
    const url = new URL(response.url())

    return (
      url.pathname === "/api/location" && url.searchParams.get("location[directory]") === directory && response.ok()
    )
  })

  await transport.close()
  await transport.waitForConnection({ after: connection.id })
  await metadata
  release.resolve()
  await resolved
  await expect(prompt).toBeEditable()
  await expect(prompt).toHaveText("Keep typing here")
  await expect(page.getByText("Session location unavailable", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Choose directory", exact: true })).toHaveCount(0)
  expect(requests).toBe(2)
  expect(recovery).toEqual([])
})

// Relocation: moving the session or creating a worktree. Showing a resolved Location also refreshes its project's
// worktree inventory (`/api/worktree/refresh`), which is routine discovery, not recovery.
function recoveryRequests(page: Page) {
  const requests: string[] = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname

    if (request.method() === "POST" && /^\/api\/(session\/[^/]+\/move|worktree)$/.test(path)) requests.push(path)
  })

  return requests
}
