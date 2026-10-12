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
export function openHref(input: string) {
  const target = resolveOpenTarget(input)
  if (!target) return Promise.reject(new Error(`Only http, https, and local file links can be opened: ${input}`))
  return open(target)
}

/** @internal */
export function resolveOpenTarget(input: string) {
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
  }
  if (path.isAbsolute(input)) return input
}
