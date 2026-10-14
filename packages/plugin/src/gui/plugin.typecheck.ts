// Type-level contract of `Plugin.define`, checked by `bun typecheck`. Nothing imports this file. Each `@ts-expect-error`
// fails the typecheck if its line stops being an error.

import { Schema } from "effect"
import { Command, Contract, Ipc, Plugin, Store } from "./index.js"

const Notes = Contract.define<{ count(): number }, "acme.notes">("acme.notes")

const Pinger = Ipc.define({ id: "acme", methods: { ping: { output: Schema.String } } })

export const plugin = Plugin.define({
  id: "acme",
  provides: { notes: Notes, pinger: Pinger },
  stores: { prefs: Store.global(Schema.Struct({ on: Schema.Boolean }), { on: true }) },
  setup(ctx) {
    ctx.provide(Notes, { count: () => 1 })
    ctx.add(Command, { id: "open", title: String(ctx.stores.prefs.value.on), run() {} })
    const live = ctx.uses.pinger()

    if (live.status === "active") void live.value.ping()

    return () => {}
  },
  main(ctx) {
    ctx.provide(Pinger, { ping: () => "pong" })
  },
})

// Split across files: declare once, type each setup from the declarations, then define the plugin with them.
const declared = Plugin.define({ id: "acme", provides: { notes: Notes } })

const setup: Plugin.Setup<typeof declared> = (ctx) => {
  ctx.provide(Notes, { count: () => 2 })
}

export const split = Plugin.define({ ...declared, setup })

export const windowOnly = Plugin.define({
  id: "acme",
  setup(ctx) {
    // @ts-expect-error a plugin provides only what it declares
    ctx.provide(Notes, { count: () => 1 })
  },
})

export const asyncWindow = Plugin.define({
  id: "acme",
  // @ts-expect-error a window setup is synchronous
  async setup() {},
})
