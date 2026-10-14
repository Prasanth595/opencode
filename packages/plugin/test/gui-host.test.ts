import { describe, expect, test } from "bun:test"
import { evaluatePluginBundle, inertModule, pluginIdAvailable, type InertModule } from "../src/gui/host"
import { Contract } from "../src/gui/core"
import { define } from "../src/gui/plugin"

const modules = new Map<string, object>([["@opencode/plugin/gui", { Contract, Plugin: { define } }]])

const evaluate = (code: string, process: "window" | "main" = "window") =>
  evaluatePluginBundle(code, {
    id: "acme",
    process,
    require: (name) => {
      const module = modules.get(name)

      if (module) return module

      if (name === "@opencode/plugin/gui/review") return inertModule(name)

      throw new Error(`not shared: ${name}`)
    },
  })

describe("plugin GUI bundles", () => {
  test("read the default export's declarations and setups", () => {
    const bundle = evaluate(`
      const sdk = require("@opencode/plugin/gui")
      exports.default = sdk.Plugin.define({
        id: "acme",
        provides: { notes: sdk.Contract.define("acme.notes") },
        i18n: { fr: { title: "Notes" } },
        setup() {},
      })
    `)

    expect(bundle.definition.provides?.notes?.id).toBe("acme.notes")
    expect(bundle.definition.i18n).toEqual({ fr: { title: "Notes" }, en: {} })
    expect(bundle.setup).toBeFunction()
    expect(bundle.main).toBeUndefined()
  })

  test("load in main when they use a window-only token, which main never reads", () => {
    const code = `
      const review = require("@opencode/plugin/gui/review")
      exports.default = { id: "acme", uses: { changes: review.Changes }, setup() {}, main() {} }
    `

    expect(evaluate(code, "main").definition.uses).toBeUndefined()
    expect(() => evaluate(code)).toThrow("must default-export a `Plugin.define`")
  })

  test("accept a bundler's default mode, where the plugin is the module itself", () => {
    expect(evaluate('module.exports = { id: "acme", main() {} }').main).toBeFunction()
  })

  // A definition built against a newer SDK can name a token this app lacks; it must fail the plugin, not the host.
  test.each([
    ["a missing token", "provides: { review: undefined }"],
    ["a token without a kind", 'uses: { review: { id: "review" } }'],
    ["a store without a schema", 'stores: { count: { scope: "global", initial: 0 } }'],
    ["an unknown OS", 'os: ["plan9"]'],
    ["a lazy catalog", "i18n: { en: {}, fr: () => ({}) }"],
    ["a setup that is not a function", "setup: true"],
  ])("reject a plugin with %s", (_, field) => {
    expect(() => evaluate(`exports.default = { id: "acme", ${field}, main() {} }`)).toThrow(
      "must default-export a `Plugin.define`",
    )
  })

  test("take the server plugin's id and have at least one setup", () => {
    expect(() => evaluate('exports.default = { id: "other", setup() {} }')).toThrow(
      'must take its server plugin\'s id "acme", not "other"',
    )
    expect(() => evaluate('exports.default = { id: "acme" }')).toThrow("must have a window `setup`")
  })
})

/** What a bundle's module scope reports back through the test's `probe` module. */
type Seen = { ready?: InertModule; window?: boolean; name?: string }

describe("inert modules", () => {
  test("give module-scope code a placeholder that ignores writes and never poses as a promise or a class", async () => {
    const seen: Seen = {}

    const probe = {
      ready: (value: InertModule) => void (seen.ready = value),
      window: (value: boolean) => void (seen.window = value),
      name: (value: string) => void (seen.name = value),
    }

    evaluatePluginBundle(
      `
        const electron = require("electron")
        const probe = require("probe")
        electron.app.name = "patched"
        probe.ready(electron.app.whenReady())
        probe.window({} instanceof electron.BrowserWindow)
        probe.name(String(electron.app.name))
        module.exports = { id: "acme", main() {} }
      `,
      { id: "acme", process: "window", require: (name) => (name === "probe" ? probe : inertModule(name)) },
    )

    // A thenable would keep this promise pending forever.
    expect(await Promise.resolve(seen.ready)).toBe(seen.ready)
    expect(seen.window).toBe(false)
    expect(seen.name).toBe("[inert module electron]")
  })
})

test.each([
  ["acme", true],
  ["file", false],
  ["file.extra", false],
  ["tools", false],
  ["opencode", false],
  ["opencode.acme", false],
  ["opencode-acme", true],
])("a plugin GUI may take the id %s: %s", (id, available) => {
  const builtins = [{ id: "file" }, { id: "tools.git" }]

  expect(pluginIdAvailable(id, builtins)).toBe(available)
})
