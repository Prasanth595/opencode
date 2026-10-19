import { expect, sourceURL, story } from "../../storybook/playwright/story"
import type { Accessor, ParentProps } from "solid-js"
import type { Command, KeyChord } from "@opencode/gui-extensions/sdk"
import type { Item } from "../src/runtime/extension/host"

const source = (path: string) => sourceURL(new URL(path, import.meta.url))

const modules = {
  fixture: source("../../gui-extensions/src/browser/panel.fixture.tsx"),
  host: source("../src/runtime/extension/host.tsx"),
  panels: source("../src/runtime/extension/panels.tsx"),
  language: source("../src/runtime/i18n/language.tsx"),
  browser: source("../../gui-extensions/src/browser/index.ts"),
  browserRenderer: source("../../gui-extensions/src/browser/renderer.tsx"),
  browserPanel: source("../../gui-extensions/src/browser/panel.tsx"),
  file: source("../../gui-extensions/src/file/index.ts"),
  fileRenderer: source("../../gui-extensions/src/file/renderer.tsx"),
  commands: source("../src/shell/commands/command.tsx"),
  sdk: source("../../gui-extensions/src/sdk/index.ts"),
  render: source("../src/runtime/extension/render.tsx"),
  settings: source("../src/settings/model.tsx"),
  platform: source("../src/runtime/platform/platform.tsx"),
  solid: source("./extension-host.fixture.tsx"),
}

story.beforeEach(async ({ mount, page }) => {
  // Any story loads the app styles; the fixture mounts the real side region and extensions beside it.
  await mount("ui-line-comment--editor")
  await page.evaluate(async (modules) => {
    const [
      { mountBrowserRegion },
      host,
      panels,
      language,
      browser,
      file,
      commands,
      sdk,
      renderer,
      settings,
      platform,
      solid,
    ] = await Promise.all([
      import(modules.fixture),
      import(modules.host),
      import(modules.panels),
      import(modules.language),
      import(modules.browser),
      import(modules.file),
      import(modules.commands),
      import(modules.sdk),
      import(modules.render),
      import(modules.settings),
      import(modules.platform),
      import(modules.solid),
      // Load the pane before mounting: Vite must not reload the page to optimize its dependencies mid-fixture.
      import(modules.browserPanel),
    ])

    mountBrowserRegion({
      LanguageProvider: language.LanguageProvider,
      ExtensionHostProvider: host.ExtensionHostProvider,
      useExtensionHost: host.useExtensionHost,
      createRegion: panels.createRegion,
      definitions: [
        { ...browser.default, renderer: () => import(modules.browserRenderer) },
        { ...file.default, renderer: () => import(modules.fileRenderer) },
      ],
      Shell: (props: ParentProps) =>
        solid.createComponent(platform.PlatformProvider, {
          value: { platform: "web", openExternal() {}, restart: async () => undefined, notify: async () => undefined },
          get children() {
            return solid.createComponent(settings.SettingsProvider, {
              get children() {
                return solid.createComponent(commands.CommandProvider, {
                  get children() {
                    return props.children
                  },
                })
              },
            })
          },
        }),
      Commands: (props: {
        close: () => void
        palette: () => void
        chords: (chords: Accessor<readonly KeyChord[]>) => void
      }) => {
        const command = commands.useCommand()
        const extensions = host.useExtensionHost()
        props.chords(command.chords)
        command.register("fixture-session", () => [
          {
            id: "tab.close",
            title: "Close session tab",
            keybind: "mod+w",
            onSelect: props.close,
          },
          {
            id: "command.palette",
            title: "Command palette",
            onSelect: props.palette,
          },
        ])
        // Storybook aliases the app's command hook to a no-op. Bridge the real extension contributions
        // to the real dispatcher imported by source URL, so the shortcut runs rather than its alias.
        command.register("fixture-extensions", () =>
          extensions.items(sdk.Command).map((item: Item<Command>) => {
            const scope = item.value.scope

            return {
              id: `${item.extension}.${item.value.id}`,
              title: item.value.title,
              keybind: item.value.bind,
              disabled: item.value.enabled === false,
              hidden: item.value.hidden,
              editable: item.value.editable,
              when: scope
                ? (event: KeyboardEvent) => event.target instanceof Element && !!event.target.closest(scope)
                : undefined,
              onSelect: () => item.value.run(),
            }
          }),
        )

        return null
      },
      Contribution: renderer.Contribution,
    })
  }, modules)
})

story("closes a blank browser tab from its address field without closing the session", async ({ page }) => {
  const root = page.getByTestId("browser-region-fixture")
  const outside = root.getByRole("button", { name: "Beta", exact: true })
  await expect(root.getByText("Registrations: 1", { exact: true })).toBeVisible()
  await outside.click()
  await expect(root.getByText("Registrations: 2", { exact: true })).toBeVisible()
  await root.getByRole("button", { name: "Blank page", exact: true }).click()
  await expect(root.getByRole("tab", { name: "New tab", exact: true })).toHaveAttribute("aria-selected", "true")

  // Prove the scope while browser.close is still registered.
  await outside.focus()
  await outside.press("ControlOrMeta+w")
  await expect(root.getByTestId("session-state")).toHaveText("closed")
  await expect(root.getByTestId("browser-closes")).toHaveText("[]")
  await expect(root.getByRole("tab", { name: "New tab", exact: true })).toBeVisible()
  await outside.click()
  await expect(root.getByTestId("session-state")).toHaveText("open")

  const address = root.getByRole("combobox", { name: "Browser address", exact: true })
  await address.fill("example.com")
  await expect(address).toBeFocused()
  await address.press("ControlOrMeta+w")
  await expect(root.getByRole("tab", { name: "New tab", exact: true })).toHaveCount(0)
  await expect(root.getByTestId("browser-closes")).toHaveText('["tab_33333333-3333-3333-3333-333333333333"]')
  await expect(root.getByTestId("session-state")).toHaveText("open")
})

story("lets a focused page handle ⌘K first and hands unhandled and reserved shortcuts to the pane", async ({ page }) => {
  const root = page.getByTestId("browser-region-fixture")
  const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform))
  const mod = mac ? "Meta" : "Control"
  const frame = page.frameLocator('iframe[title="Browser page"]')
  const editor = frame.getByRole("textbox", { name: "Editor page input", exact: true })
  const plain = frame.getByRole("textbox", { name: "Plain page input", exact: true })
  await expect(root.getByText("Registrations: 1", { exact: true })).toBeVisible()
  await root.getByRole("button", { name: "Beta", exact: true }).click()
  await expect(root.getByText("Registrations: 2", { exact: true })).toBeVisible()
  await root.getByRole("button", { name: "First inventory", exact: true }).click()
  await expect(root.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true")

  // A page that calls preventDefault() on ⌘K keeps it; the app palette does not run.
  await editor.focus()
  await editor.press(`${mod}+k`)
  await expect(editor).toHaveValue("handled:k")
  await expect(root.getByTestId("palette-runs")).toHaveText("0")

  // A page that leaves ⌘K unhandled hands it back to the app.
  await plain.focus()
  await plain.press(`${mod}+k`)
  await expect(root.getByTestId("palette-runs")).toHaveText("1")

  // Reserved ⌘W is claimed before the page sees it and runs the pane's close, not the session's.
  await editor.focus()
  await editor.press(`${mod}+w`)
  await expect(editor).toHaveValue("handled:k")
  await expect(root.getByTestId("browser-closes")).toHaveText('["tab_33333333-3333-3333-3333-333333333333"]')
  await expect(root.getByTestId("session-state")).toHaveText("open")
})

story("keeps a restored browser tab selected and undrawn until the desktop's first inventory", async ({ page }) => {
  const root = page.getByTestId("browser-region-fixture")
  const tabs = root.getByRole("tab")
  const tree = root.getByTestId("tree")
  await expect(root.getByText("Registrations: 1", { exact: true })).toBeVisible()
  await expect(tabs).toHaveText(["alpha.ts"])
  await expect(tree).toHaveText('{"tab":"changes"}')

  // Beta was left on its browser tab, which the desktop has not reported yet.
  await root.getByRole("button", { name: "Beta", exact: true }).click()
  await expect(root.getByText("Registrations: 2", { exact: true })).toBeVisible()
  await expect(root.getByTestId("selected")).toHaveText(/^browser:tab_/)
  await expect(tabs).toHaveText(["beta.ts"])
  // No fallback tab was selected, so the file tab's selection never switched the tree to All files.
  await expect(tree).toHaveText('{"tab":"changes"}')

  await root.getByRole("button", { name: "First inventory", exact: true }).click()
  await expect(tabs).toHaveText(["beta.ts", "Preview"])
  await expect(root.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(tree).toHaveText('{"tab":"changes"}')
})

story(
  "keeps the browser tabs while the pane's Ipc is away and registers them again when it returns",
  async ({ page }) => {
    const root = page.getByTestId("browser-region-fixture")
    const tabs = root.getByRole("tab")
    await expect(root.getByText("Registrations: 1", { exact: true })).toBeVisible()
    await root.getByRole("button", { name: "Beta", exact: true }).click()
    await expect(root.getByText("Registrations: 2", { exact: true })).toBeVisible()
    await root.getByRole("button", { name: "First inventory", exact: true }).click()
    await expect(tabs).toHaveText(["beta.ts", "Preview"])

    // The pane's main extension reloads: every binding goes with it, and the strip keeps the tab it will restore.
    await root.getByRole("button", { name: "Pane away", exact: true }).click()
    await expect(tabs).toHaveText(["beta.ts", "Preview"])
    await expect(root.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true")

    // Both attachments register again at once, without a retry timer; Beta hands main the tab to restore.
    await root.getByRole("button", { name: "Pane back", exact: true }).click()
    await expect(root.getByText("Registrations: 4", { exact: true })).toBeVisible()
    await expect(root.getByText("Beta restores: 1", { exact: true })).toBeVisible()
    await expect(tabs).toHaveText(["beta.ts", "Preview"])
  },
)
