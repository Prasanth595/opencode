export * as Host from "./host.js"

import { createRequire } from "node:module"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { importModule, resolveModule } from "@opencode/util/runtime-import"

export interface Target {
  readonly directory: string
  readonly name?: string
}

export interface Entrypoints {
  readonly server?: string
  readonly tui?: string
  readonly rpc?: string
}

export function resolve(target: Target): Entrypoints {
  // Configured local plugins are directories. Resolving only `<dir>/index`
  // skips package.json `main` and `exports`, so the plugin is dropped.
  const manifest = target.name ? undefined : readManifest(target.directory)
  const entry = (subpaths: readonly string[]) => {
    for (const subpath of subpaths) {
      const resolved = resolveSubpath(target, manifest, subpath)
      if (resolved) return resolved
    }
    return undefined
  }
  return { server: entry(["server", ""]), tui: entry(["tui"]), rpc: entry(["rpc"]) }
}

function resolveSubpath(
  target: Target,
  manifest: { readonly name?: string; readonly main?: string; readonly exports: boolean } | undefined,
  subpath: string,
) {
  if (target.name) return resolveFile([target.name, subpath].filter(Boolean).join("/"), target.directory)
  if (subpath) {
    return (
      resolveFile(path.resolve(target.directory, subpath), target.directory) ??
      resolvePackageName(target.directory, manifest?.name ? `${manifest.name}/${subpath}` : undefined)
    )
  }
  return (
    resolveFile(target.directory, target.directory) ??
    resolvePackageName(target.directory, manifest?.name) ??
    resolveDeclaredMain(target.directory, manifest) ??
    resolveFile(path.resolve(target.directory, "index"), target.directory)
  )
}

function resolvePackageName(directory: string, specifier: string | undefined) {
  if (!specifier) return
  const resolved = resolveFile(specifier, directory)
  if (!resolved || !inside(directory, resolved)) return
  return resolved
}

function resolveFile(specifier: string, directory: string) {
  try {
    const resolved = resolveModule(specifier, directory)
    if (resolved.startsWith("file:") && !statSync(fileURLToPath(resolved)).isFile()) return
    return resolved
  } catch (error) {
    if (missing(error)) return
    throw error
  }
}

// Node's directory resolver returns the directory itself. `main` without
// `exports` still has to be read from the manifest there; Bun already follows it.
function resolveDeclaredMain(
  directory: string,
  manifest: { readonly main?: string; readonly exports: boolean } | undefined,
) {
  if (!manifest?.main || manifest.exports) return
  try {
    const resolved = pathToFileURL(createRequire(path.join(directory, "package.json")).resolve(directory)).href
    if (!statSync(fileURLToPath(resolved)).isFile()) return
    if (!inside(directory, resolved)) return
    return resolved
  } catch (error) {
    if (missing(error)) return
    throw error
  }
}

function readManifest(directory: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"))
  } catch {
    return
  }
  if (typeof parsed !== "object" || parsed === null) return
  const name = "name" in parsed && typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : undefined
  const main = "main" in parsed && typeof parsed.main === "string" && parsed.main.length > 0 ? parsed.main : undefined
  return { name, main, exports: "exports" in parsed }
}

function inside(root: string, resolved: string) {
  const relative = path.relative(root, fileURLToPath(resolved))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function missing(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    [
      "ENOENT",
      "ENOTDIR",
      "MODULE_NOT_FOUND",
      "ERR_MODULE_NOT_FOUND",
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
      "ERR_UNSUPPORTED_DIR_IMPORT",
    ].includes(String(error.code))
  )
}

export function load(entrypoint: string): Promise<unknown> {
  return importModule(entrypoint)
}
