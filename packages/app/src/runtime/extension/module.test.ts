import { describe, expect, test } from "bun:test"
import { Command, type Registry } from "@opencode/plugin/gui"
import { pluginDefinition } from "./module"

// One `./gui` bundle for both processes, as a bundler emits it: requires hoisted to module scope, including Electron
// and Node built-ins that only the main setup uses.
const bundle = `
const sdk = require("@opencode/plugin/gui")
const mainSdk = require("@opencode/plugin/gui/main")
const solid = require("solid-js")
const electron = require("electron")
const fs = require("node:fs")
const app = new electron.BrowserWindow().app.whenReady()
const Notes = mainSdk.Contract.define("acme.notes")
exports.default = sdk.Plugin.define({
  id: "acme",
  provides: { notes: Notes },
  i18n: { en: { title: "Notes" } },
  setup(ctx) {
    const [count] = solid.createSignal(1)
    ctx.add(sdk.Command, { id: "open", title: ctx.t("title") + count(), run() {} })
    return () => ctx.add(sdk.Command, { id: "closed", title: "", run() {} })
  },
  main: () => app.then(() => fs.readFileSync("notes.json")),
})
`

describe("plugin GUIs in a window", () => {
  test("declare their definition before they start, with the app's module instances and Electron inert", async () => {
    const definition = await pluginDefinition("acme", bundle)
    const added: { readonly registry: Registry<Command>; readonly item: Command }[] = []

    expect(definition.provides?.notes?.id).toBe("acme.notes")
    expect(definition.i18n?.en).toEqual({ title: "Notes" })

    const entry = await definition.renderer?.()

    const ctx = {
      add: (registry: Registry<Command>, item: Command) => void added.push({ registry, item }),
      t: () => "Notes",
    }

    // SAFETY: the window setup only calls `add` and `t`, which this stand-in context provides.
    const cleanup = entry?.default(ctx as never)

    // The bundle's `Command` is the app's own token, so the host recognizes what it contributes.
    expect(added[0]?.registry).toBe(Command)
    expect(added[0]?.item).toMatchObject({ id: "open", title: "Notes1" })
    // The setup's returned cleanup reaches the host.
    expect(cleanup).toBeFunction()
  })

  test.each([
    [
      "a module the app does not share",
      'require("left-pad"); exports.default = { id: "acme", setup() {} }',
      "left-pad",
    ],
    ["another id", 'exports.default = { id: "other", setup() {} }', 'not "other"'],
  ])("fail only their own entry when they require %s", async (_, code, message) => {
    const definition = await pluginDefinition("acme", code)

    expect(definition.id).toBe("acme")
    await expect(definition.renderer?.()).rejects.toThrow(message)
  })
})
