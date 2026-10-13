import { Option, Predicate, Schema } from "effect"
import type { Catalog, Context, Definition } from "@opencode/gui-extensions/sdk"
import { inertModule } from "@opencode/gui-extensions/sdk/bridge"

// Plugin bundles share the host's module instances, so tokens, contexts and schemas they import
// are the same objects the host checks against.
const shared = new Map<string, () => Promise<object>>([
  ["solid-js", () => import("solid-js")],
  ["solid-js/web", () => import("solid-js/web")],
  ["solid-js/store", () => import("solid-js/store")],
  ["effect", () => import("effect")],
  ["@opencode/gui-extensions/sdk", () => import("@opencode/gui-extensions/sdk")],
  ["@opencode/gui-extensions/file", () => import("@opencode/gui-extensions/file")],
  ["@opencode/gui-extensions/review", () => import("@opencode/gui-extensions/review")],
  ["@opencode/gui-extensions/browser", () => import("@opencode/gui-extensions/browser")],
  ["@opencode/gui-extensions/updater", () => import("@opencode/gui-extensions/updater")],
  ["@opencode/schema/rpc", () => import("@opencode/schema/rpc")],
  ["@opencode/client", () => import("@opencode/client")],
  ["@opencode/client/effect", () => import("@opencode/client/effect")],
  ["@opencode/client/solid", () => import("@opencode/client/solid")],
  ["@opencode/ui/icons/catalog", () => import("@opencode/ui/icons/catalog")],
  // A plugin's `./gui` bundle serves both processes. In a window, the main SDK's name resolves to the window SDK,
  // which exports the same `Extension`, `Store`, `Ipc`, `Contract` and `Registry`.
  ["@opencode/gui-extensions/sdk/main", () => import("@opencode/gui-extensions/sdk")],
])

const nodeBuiltins = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "fs/promises",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "process",
  "readline",
  "stream",
  "timers",
  "tls",
  "url",
  "util",
  "worker_threads",
  "zlib",
])

// A bundle's catalog ships every locale inline; only built-ins load locales lazily.
const InlineCatalog = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))

/** The CommonJS module a bundle fills: its setups, optional definition, and optional catalog. */
type Module = { exports: { default?: object; main?: object; definition?: object; i18n?: object } }

export type EvaluatedRenderer = {
  /** The window setup, the bundle's default export. A bundle that only exports `main` has none. */
  readonly setup?: (ctx: Context) => void
  /** The bundle also exports `main`, a setup for the desktop app's main process. */
  readonly main: boolean
  readonly definition?: Definition
  readonly i18n?: Catalog
}

/**
 * Evaluates a plugin's `./gui` bundle as CommonJS against the shared module map. The bundle serves both processes, so
 * it may require any shared module, the modules only main has resolve to inert placeholders, and it default-exports a
 * window setup, exports a `main` setup, or both.
 */
export async function evaluateRenderer(source: string): Promise<EvaluatedRenderer> {
  const modules = new Map(await Promise.all([...shared].map(async ([name, load]) => [name, await load()] as const)))

  const module: Module = { exports: {} }

  // A plugin's code is trusted as much as the server that runs the app, which already runs its server entry.
  new Function("require", "module", "exports", source)(
    (name: string) => {
      const loaded = modules.get(name)

      if (loaded) return loaded

      if (mainOnly(name)) return inertModule(name)

      throw new Error(`Extension module is not shared by the app: ${name}`)
    },
    module,
    module.exports,
  )
  const setup = module.exports.default
  const main = Predicate.isFunction(module.exports.main)
  const definition = isDefinition(module.exports.definition) ? module.exports.definition : undefined
  const i18n = module.exports.i18n

  if (!Predicate.isFunction(setup) && !main)
    throw new Error("Plugin GUI bundle must default-export a window setup or export a main setup")
  const catalog = i18n === undefined ? undefined : Schema.decodeUnknownOption(InlineCatalog)(i18n)

  if (catalog && Option.isNone(catalog)) throw new Error("Extension i18n catalog is invalid")

  return {
    // SAFETY: a bundle is plain JavaScript; a function default export is its setup, all the host can check of it.
    setup: Predicate.isFunction(setup) ? (setup as (ctx: Context) => void) : undefined,
    main,
    definition,
    i18n: (catalog && { en: {}, ...catalog.value }) ?? definition?.i18n,
  }
}

function isDefinition(value: Module["exports"]["definition"]): value is Definition {
  return !!value && Predicate.hasProperty(value, "id") && Predicate.isString(value.id)
}

/** A module only the desktop app's main process has: Electron and Node built-ins. */
function mainOnly(name: string) {
  return name === "electron" || name.startsWith("node:") || nodeBuiltins.has(name)
}

/**
 * Builds a host `Definition` for a plugin package's `./gui` bundle, read from the server that runs the app. The bundle
 * is evaluated here so its exported `definition` declares `provides`, `uses`, `requires` and `stores` before the host
 * gates activation on them; its id is always the plugin's. A bundle that only exports `main` gets an empty window setup,
 * so it still lists as active. A bundle that fails to evaluate becomes a definition whose entry fails, so the extension
 * manager reports it.
 */
export async function pluginDefinition(
  id: string,
  source: string,
): Promise<{ readonly main: boolean; readonly definition: Definition }> {
  const evaluated = await evaluateRenderer(source).then(
    (value) => ({ ok: true as const, value }),
    (cause: unknown) => ({ ok: false as const, cause }),
  )

  if (!evaluated.ok) return { main: false, definition: { id, renderer: () => Promise.reject(evaluated.cause) } }

  const setup = evaluated.value.setup

  return {
    main: evaluated.value.main,
    definition: {
      ...evaluated.value.definition,
      id,
      i18n: evaluated.value.i18n,
      renderer: async () => ({ default: (ctx: never) => setup?.(ctx) }),
    },
  }
}
