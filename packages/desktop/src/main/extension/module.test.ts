import { expect, test } from "bun:test"
import path from "node:path"
import { evaluateMain } from "./module"

// One `./gui` bundle for both processes, as Vite emits it with vite-plugin-solid: Solid's templates and event delegation
// run at module scope, beside the Node built-ins only the main setup uses.
const bundle = `
const web = require("solid-js/web")
const path = require("node:path")
const sdk = require("@opencode/gui-extensions/sdk")
const tmpl = web.template("<p>Notes</p>")
web.delegateEvents(["click"])
exports.definition = sdk.Extension.define({ id: "acme", stores: { count: sdk.Store.main(require("effect").Schema.Number, 0) } })
exports.default = () => tmpl()
exports.main = () => path.join("a", "b")
`

test("main runs a plugin bundle's main setup, with the window-only modules inert and Node built-ins real", async () => {
  const loaded = await evaluateMain(bundle)

  // SAFETY: the bundle's main setup reads no context.
  expect(loaded.setup({} as never)).toBe(path.join("a", "b"))
  expect(Object.keys(loaded.stores ?? {})).toEqual(["count"])
})

test("main refuses a plugin bundle without a main setup", async () => {
  await expect(evaluateMain("exports.default = () => {}")).rejects.toMatchObject({
    code: "invalidModule",
    message: "main",
  })
})
