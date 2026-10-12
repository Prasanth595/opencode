import open from "open"
import path from "node:path"
import { fileURLToPath } from "node:url"

export function openUrl(input: string) {
  const url = URL.canParse(input) ? new URL(input) : undefined
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
    return Promise.reject(new Error(`Only http and https links can be opened in the browser: ${input}`))
  return open(url.href)
}

export function openPath(target: string) {
  return open(target)
}

/** Open an http(s) URL in the browser, or a local file path / file:// link with the OS handler. */
export function openHref(input: string, base?: string) {
  const target = resolveOpenTarget(input, base)
  if (!target) return Promise.reject(new Error(`Only http, https, and local file links can be opened: ${input}`))
  return open(target)
}

/** @internal */
export function resolveOpenTarget(input: string, base?: string) {
  if (URL.canParse(input)) {
    const url = new URL(input)
    if (url.protocol === "http:" || url.protocol === "https:") return url.href
    // Match desktop: only local file URLs (no host) become filesystem paths.
    if (url.protocol === "file:" && !url.hostname) {
      try {
        return fileURLToPath(url.href)
      } catch {
        return undefined
      }
    }
    return undefined
  }
  if (path.isAbsolute(input)) return input
  // Resolve project-relative Markdown links such as plan/example.md against the session directory.
  if (base !== undefined && input.length > 0 && !input.startsWith("#")) return path.resolve(base, input)
}
