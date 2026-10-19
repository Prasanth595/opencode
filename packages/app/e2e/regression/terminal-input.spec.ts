import { base64Encode, checksum } from "@opencode/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { sessionHref } from "../utils/app"
import { mockWorkspace, openSession, type WorkspaceInput } from "../utils/workspace"
import { expectSessionTitle } from "../utils/waits"

const workspace = { name: "TerminalInput", pty: {} } satisfies WorkspaceInput

test.use({ viewport: { width: 1440, height: 900 } })

test("toggles the terminal open and closed with Mod+J and Control+Backquote while focused", async ({ page }) => {
  const { pty } = await openSession(page, workspace)
  const terminal = page.locator('[data-component="terminal"]')

  for (const shortcut of ["ControlOrMeta+j", "Control+Backquote"] as const) {
    await page.keyboard.press(shortcut)
    await expect(terminal).toBeVisible()
    await expect(terminal.locator("textarea")).toHaveCount(1)
    await expect.poll(() => pty.sockets.length).toBe(1)
    await expect.poll(() => terminal.evaluate((element) => element.contains(document.activeElement))).toBe(true)

    await page.keyboard.press(shortcut)
    await expect(terminal).toBeHidden()
    expect(pty.sockets[0]!.input).toEqual([])
  }
})

test("clears the terminal line with Command+Delete", async ({ page }) => {
  const { pty } = await openSession(page, workspace)
  const terminal = page.locator('[data-component="terminal"]')
  await page.keyboard.press("Control+Backquote")
  await expect(terminal.locator("textarea")).toHaveCount(1)
  await expect.poll(() => pty.sockets.length).toBe(1)

  await page.keyboard.press("Meta+Backspace")
  await expect.poll(() => pty.sockets[0]!.input.join("")).toBe("\x15")
})

test("reveals the terminal after its first output and hides the native caret", async ({ page }) => {
  const { pty } = await openSession(page, workspace)
  await page.keyboard.press("Control+Backquote")
  const terminal = page.locator('[data-component="terminal"]')
  await expect(terminal).toHaveAttribute("contenteditable", "true")
  await expect(terminal).toHaveCSS("caret-color", "rgba(0, 0, 0, 0)")
  await expect(terminal).toHaveCSS("opacity", "0")
  await expect.poll(() => pty.sockets.length).toBe(1)

  pty.send("\x1b[?25h")
  await expect(terminal).toHaveCSS("opacity", "0")
  pty.send("ready")
  await expect(terminal).toHaveCSS("opacity", "1")
})

test("routes typing to the composer unless the open terminal is focused", async ({ page }) => {
  const { pty, editor } = await openSession(page, workspace)
  const terminal = page.locator('[data-component="terminal"]')
  await editor.click()
  await expect(editor).toBeFocused()
  await page.keyboard.press("Control+Backquote")
  await expect(terminal).toBeVisible()
  await expect.poll(() => terminal.evaluate((element) => element.contains(document.activeElement))).toBe(true)

  await page.keyboard.type("x")
  await expect(editor).toHaveText("")
  await expect.poll(() => pty.sockets.length).toBe(1)
  pty.send("ready")
  await expect(terminal).toHaveCSS("opacity", "1")
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.keyboard.type("a")
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText("a")
})

for (const mount of ["cached", "explicit"] as const) {
  test(`keeps newer composer focus while a ${mount} terminal finishes mounting`, async ({ page }) => {
    const ghostty = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await page.route(/ghostty-web/, async (route) => {
      ghostty.resolve()
      await release.promise
      await route.continue()
    })
    const cached = { id: "pty_cached", title: "Terminal 1" }

    const { pty, sessions } = await mockWorkspace(page, {
      ...workspace,
      pty: mount === "cached" ? { initial: [cached] } : {},
      seed: mount === "cached" ? restoredTerminal(cached) : undefined,
    })

    await page.goto(sessionHref(sessions[0]!.id), { waitUntil: "commit" })
    await expectSessionTitle(page, "TerminalInput")
    const editor = page.locator('[data-component="composer-editor"]')
    const terminal = page.locator('[data-component="terminal"]')

    if (mount === "explicit") {
      await expect(editor).toBeEditable()
      await page.keyboard.press("Control+Backquote")
    }

    await expect(terminal).toBeVisible()
    await ghostty.promise
    await editor.click()
    await expect(editor).toBeFocused()

    release.resolve()
    await expect(terminal.locator("textarea")).toHaveCount(1)
    await expect.poll(() => pty.sockets.length).toBe(1)
    pty.send("ready")
    await expect(terminal).toHaveCSS("opacity", "1")
    await expect(editor).toBeFocused()

    if (mount === "cached") expect(pty.created).toEqual([])
  })
}

test("reconnects the same terminal after a transient connection failure", async ({ page }) => {
  const { pty } = await openSession(page, workspace)
  let tickets = 0
  await page.route(/\/api\/pty\/[^/]+\/connect-token/, (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback()
    tickets += 1

    if (tickets !== 2) return route.fallback()

    return route.fulfill({
      status: 503,
      headers: { "access-control-allow-origin": "*" },
      body: "Service Unavailable",
    })
  })
  await page.keyboard.press("Control+Backquote")
  const terminal = page.locator('[data-component="terminal"]')
  await expect(terminal.locator("textarea")).toHaveCount(1)
  await expect.poll(() => pty.sockets.length).toBe(1)
  const id = pty.sockets[0]!.id
  await terminal.evaluate((element) => element.setAttribute("data-connection-probe", "original"))

  await pty.sockets[0]!.close(1011, "Temporary disconnection")
  await expect.poll(() => tickets).toBe(3)
  await expect.poll(() => pty.sockets.length).toBe(2)
  expect(pty.sockets[1]!.id).toBe(id)
  expect(pty.rejected).toEqual([])
  await expect(terminal).toHaveAttribute("data-connection-probe", "original")
  expect(pty.created.map((item) => item.id)).toEqual([id])
})

test("opens terminals as side panel tabs from the + menu", async ({ page }) => {
  const { editor, pty } = await openSession(page, workspace)
  const panel = page.locator("#review-panel")
  const terminal = page.locator('[data-component="terminal"]')
  await page.keyboard.press("Control+Backquote")
  await expect(panel.getByRole("tab", { name: "Terminal 1", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(terminal.locator("textarea")).toHaveCount(1)

  const add = async () => {
    await editor.click()
    await expect(editor).toBeFocused()
    await panel.getByRole("button", { name: "Add tab", exact: true }).click()
    await page.getByRole("menuitem", { name: /^Terminal/ }).click()
  }

  for (const number of [2, 3]) {
    await add()
    await expect(panel.getByRole("tab", { name: `Terminal ${number}`, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    const active = page.locator(`#terminal-wrapper-pty_${number} [data-component="terminal"]`)
    await expect.poll(() => active.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  }

  // Closing a tab closes its terminal, and the next one takes the lowest free number.
  await closeTab(page, "pty_2")
  await expect.poll(() => pty.removed).toEqual(["pty_2"])
  await expect(panel.getByRole("tab", { name: /^Terminal / })).toHaveText(["Terminal 1", "Terminal 3"])
  await add()
  await expect(panel.getByRole("tab", { name: /^Terminal / })).toHaveText(["Terminal 1", "Terminal 3", "Terminal 2"])
  await expect(panel.getByRole("tab", { name: "Terminal 2", exact: true })).toHaveAttribute("aria-selected", "true")
})

test("focuses the terminal opened from the command palette", async ({ page }) => {
  const { editor } = await openSession(page, workspace)
  const terminal = page.locator('[data-component="terminal"]')
  await editor.click()
  await page.keyboard.press("ControlOrMeta+Shift+P")
  const palette = page.getByRole("dialog")
  const search = palette.getByRole("textbox")
  await expect(search).toBeFocused()
  await search.fill("Toggle terminal")
  await expect(palette.getByRole("option", { name: /^Toggle terminal/ })).toHaveAttribute("aria-selected", "true")

  await search.press("Enter")
  await expect(palette).toHaveCount(0)
  await expect(terminal.locator("textarea")).toHaveCount(1)
  await expect.poll(() => terminal.evaluate((element) => element.contains(document.activeElement))).toBe(true)
})

test("closing the last restored terminal does not create a hidden replacement", async ({ page }) => {
  const cached = { id: "pty_cached", title: "Terminal 1" }
  const { pty } = await openSession(page, { ...workspace, pty: { initial: [cached] }, seed: restoredTerminal(cached) })
  const panel = page.locator("#review-panel")
  const tab = panel.getByRole("tab", { name: "Terminal 1", exact: true })

  const terminal = page.locator('[data-component="terminal"]')
  await expect(terminal.locator("textarea")).toHaveCount(1)
  await expect.poll(() => pty.sockets.length).toBe(1)
  expect(pty.created).toEqual([])

  await closeTab(page, cached.id)
  await expect(terminal).toBeHidden()
  await expect.poll(() => pty.removed).toEqual([cached.id])
  expect(pty.created).toEqual([])

  await page.keyboard.press("Control+Backquote")
  await expect(terminal.locator("textarea")).toHaveCount(1)
  await expect.poll(() => pty.created.map((item) => item.id)).toEqual(["pty_1"])
  await expect(tab).toHaveAttribute("aria-selected", "true")
})

// A terminal tab restored open in the side panel, with the terminal in the pre-extension store, which the terminal
// extension imports.
function restoredTerminal(pty: { id: string; title: string }) {
  const key = `terminal:${pty.id}`

  return {
    panes: { ses_terminalinput: { review: true } },
    storage: {
      [legacyTerminalKey()]: { active: pty.id, all: [{ ...pty, titleNumber: 1 }] },
      "opencode.global.dat:layout": {
        sessionTabs: { [`local\u0000${directory()}/ses_terminalinput`]: { all: [key], active: key } },
      },
    },
  }
}

function closeTab(page: Page, id: string) {
  return page
    .locator(`#review-panel [data-value="terminal:${id}"]`)
    .first()
    .getByRole("button", { name: "Close tab", exact: true })
    .click()
}

function directory() {
  return base64Encode("C:/OpenCode/TerminalInput")
}

function legacyTerminalKey() {
  const dir = directory()
  const head = dir.slice(0, 12).replace(/[^a-zA-Z0-9._-]/g, "-")

  return `opencode.workspace.${head}.${checksum(dir) ?? "0"}.dat:workspace:terminal`
}
