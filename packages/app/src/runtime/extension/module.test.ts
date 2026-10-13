import { describe, expect, test } from "bun:test"
import { Command, type Registry } from "@opencode/gui-extensions/sdk"
import { inertModule } from "@opencode/gui-extensions/sdk/bridge"
import { evaluateRenderer, pluginDefinition } from "./module"

// One `./gui` bundle for both processes, as a bundler emits it: requires hoisted to module scope, including Electron
// and Node built-ins that only the main setup uses.
const bundle = `
const sdk = require("@opencode/gui-extensions/sdk")
const mainSdk = require("@opencode/gui-extensions/sdk/main")
const solid = require("solid-js")
const electron = require("electron")
const fs = require("node:fs")
const Notes = mainSdk.Contract.define("acme.notes")
exports.definition = sdk.Extension.define({ id: "ignored", provides: { notes: Notes }, i18n: { en: { title: "Notes" } } })
exports.default = (ctx) => {
  const [count] = solid.createSignal(1)
  ctx.add(sdk.Command, { id: "open", title: ctx.t("title") + count(), run() {} })
}
exports.main = (ctx) => {
  electron.powerSaveBlocker.start("prevent-display-sleep")
  fs.readFileSync("notes.json")
}
`

describe("plugin GUI bundles", () => {
  test("declare their definition before they start, under the plugin's id, with the app's module instances", async () => {
    const loaded = await pluginDefinition("acme", bundle)
    const added: { readonly registry: Registry<Command>; readonly item: Command }[] = []

    expect(loaded.main).toBe(true)
    expect(loaded.definition.id).toBe("acme")
    expect(loaded.definition.provides?.notes?.id).toBe("acme.notes")
    expect(loaded.definition.i18n?.en).toEqual({ title: "Notes" })

    const entry = await loaded.definition.renderer?.()

    const ctx = {
      add: (registry: Registry<Command>, item: Command) => void added.push({ registry, item }),
      t: () => "Notes",
    }

    // SAFETY: the bundle's window setup only calls `add` and `t`, which this stand-in context provides.
    entry?.default(ctx as never)

    // The bundle's `Command` is the app's own token, so the host recognizes what it contributes.
    expect(added[0]?.registry).toBe(Command)
    expect(added[0]?.item).toMatchObject({ id: "open", title: "Notes1" })
  })

  test("evaluate a main-only bundle in a window, where Electron is an inert placeholder", async () => {
    // Module-scope use of Electron, as a bundler or a careless author may emit it, must not stop the window.
    const evaluated = await evaluateRenderer(
      'const electron = require("electron"); const app = new electron.BrowserWindow().app.whenReady(); exports.main = () => app',
    )

    expect(evaluated.main).toBe(true)
    expect(evaluated.setup).toBeUndefined()
  })

  test("never let an inert placeholder block the promise that resolves with it", async () => {
    const placeholder = inertModule("electron")

    expect(await Promise.resolve(placeholder)).toBe(placeholder)
    expect(`${placeholder}`).toBe("[inert module electron]")
  })

  test("reject a module the app does not share", async () => {
    await expect(evaluateRenderer('require("left-pad"); exports.default = () => {}')).rejects.toThrow(
      "Extension module is not shared by the app: left-pad",
    )
  })

  test("fail the extension's entry when the bundle exports no setup", async () => {
    const loaded = await pluginDefinition("broken", "exports.default = 1")

    expect(loaded.definition.id).toBe("broken")
    await expect(loaded.definition.renderer?.()).rejects.toThrow(
      "Plugin GUI bundle must default-export a window setup or export a main setup",
    )
  })
})
