export * as Host from "./host.js"

import path from "node:path"
import { importModule, resolveModule } from "@opencode/util/runtime-import"

export interface Target {
  readonly directory: string
  readonly name?: string
}

export interface Entrypoints {
  readonly server?: string
  readonly tui?: string
  readonly rpc?: string
  /**
   * The prebuilt CommonJS GUI bundle (`./gui`, or `gui.cjs` or `gui.js` in a local directory). Each desktop app window
   * runs its default export; the desktop app's main process runs its `main` export.
   */
  readonly gui?: string
}

export function resolve(target: Target): Entrypoints {
  const entry = (subpaths: readonly string[]) => {
    for (const subpath of subpaths) {
      const specifier = target.name
        ? [target.name, subpath].filter(Boolean).join("/")
        : path.resolve(target.directory, subpath || "index")
      try {
        return resolveModule(specifier, target.directory)
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          ![
            "ENOENT",
            "ENOTDIR",
            "MODULE_NOT_FOUND",
            "ERR_MODULE_NOT_FOUND",
            "ERR_PACKAGE_PATH_NOT_EXPORTED",
            "ERR_UNSUPPORTED_DIR_IMPORT",
          ].includes(String(error.code))
        )
          throw error
      }
    }
    return undefined
  }
  return {
    server: entry(["server", ""]),
    tui: entry(["tui"]),
    rpc: entry(["rpc"]),
    // The app evaluates the bundle as CommonJS text, so a TypeScript source or an ES module is never a GUI entry.
    gui: [target.name ? entry(["gui"]) : entry(["gui.cjs", "gui.js"])].find((file) => file && /\.c?js$/.test(file)),
  }
}

export function load(entrypoint: string): Promise<unknown> {
  return importModule(entrypoint)
}
