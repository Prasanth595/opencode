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
   * A prebuilt CommonJS GUI extension bundle (`./gui`). Each app window runs its default export; the desktop app's main
   * process runs its `main` export.
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
    gui: entry(["gui"]),
  }
}

export function load(entrypoint: string): Promise<unknown> {
  return importModule(entrypoint)
}
