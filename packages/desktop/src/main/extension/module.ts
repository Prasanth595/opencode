import { createRequire, isBuiltin } from "node:module"
import { inertModule } from "@opencode/gui-extensions/sdk/bridge"
import type { Definition, MainSetup } from "@opencode/gui-extensions/sdk/main"
import { Option, Predicate, Schema } from "effect"
import { ExtensionError } from "./error"

const native = createRequire(import.meta.url)

// Plugin bundles share the host's module instances, so tokens and schemas they import are the
// same objects the host checks against.
const shared = new Map<string, () => Promise<object>>([
  ["effect", () => import("effect")],
  ["@opencode/gui-extensions/sdk/main", () => import("@opencode/gui-extensions/sdk/main")],
  // One `index.ts` and `contract.ts` serve both processes: in main, the window SDK's name resolves to the main SDK,
  // which exports the same `Extension`, `Store`, `Ipc`, `Contract` and `Registry`.
  ["@opencode/gui-extensions/sdk", () => import("@opencode/gui-extensions/sdk/main")],
  ["@opencode/schema/rpc", () => import("@opencode/schema/rpc")],
  ["@opencode/client", () => import("@opencode/client")],
  ["@opencode/client/effect", () => import("@opencode/client/effect")],
])

// The modules only a window shares; in main they are inert placeholders.
const windowOnly = new Set([
  "solid-js",
  "solid-js/web",
  "solid-js/store",
  "@opencode/gui-extensions/file",
  "@opencode/gui-extensions/review",
  "@opencode/gui-extensions/browser",
  "@opencode/gui-extensions/updater",
  "@opencode/client/solid",
  "@opencode/ui/icons/catalog",
])

// A bundle's catalog ships every locale inline; only built-ins load locales lazily.
const InlineCatalog = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))

/** The CommonJS module a bundle fills: its setups, optional definition, and optional catalog. */
type Module = { exports: { main?: object; definition?: object; i18n?: object } }

/**
 * Evaluates a plugin's `./gui` bundle as CommonJS and returns its `main` setup. The bundle serves both processes, so it
 * may require any shared module, `electron` or a Node built-in, and the window-only modules resolve to inert
 * placeholders.
 */
export async function evaluateMain(source: string) {
  const modules = new Map(await Promise.all([...shared].map(async ([name, load]) => [name, await load()] as const)))

  const module: Module = { exports: {} }

  // A plugin's code is trusted as much as the server that runs the app, which already runs its server entry.
  new Function("require", "module", "exports", source)(
    (name: string) => {
      const loaded = modules.get(name)

      if (loaded) return loaded

      if (name === "electron" || isBuiltin(name)) return native(name)

      if (windowOnly.has(name)) return inertModule(name)

      throw new ExtensionError("invalidModule", { message: name })
    },
    module,
    module.exports,
  )
  const setup = module.exports.main
  const definition = isDefinition(module.exports.definition) ? module.exports.definition : undefined
  const i18n = module.exports.i18n

  if (!Predicate.isFunction(setup)) throw new ExtensionError("invalidModule", { message: "main" })
  const catalog = i18n === undefined ? undefined : Schema.decodeUnknownOption(InlineCatalog)(i18n)

  if (catalog && Option.isNone(catalog)) throw new ExtensionError("invalidModule", { message: "i18n" })

  // SAFETY: a bundle is plain JavaScript; a function `main` export is its setup, all the host can check of it.
  return {
    setup: setup as MainSetup,
    i18n: (catalog && { en: {}, ...catalog.value }) ?? definition?.i18n,
    stores: definition?.stores,
    provides: definition?.provides,
  }
}

function isDefinition(value: Module["exports"]["definition"]): value is Definition {
  return !!value && Predicate.hasProperty(value, "id") && Predicate.isString(value.id)
}
