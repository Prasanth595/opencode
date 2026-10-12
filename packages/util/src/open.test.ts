import { describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { openUrl, resolveOpenTarget } from "./open.js"

describe("openUrl", () => {
  test("rejects values that are not URLs", async () => {
    await expect(openUrl("not a url")).rejects.toThrow("Only http and https links")
    await expect(openUrl("")).rejects.toThrow("Only http and https links")
  })

  test("rejects non-http schemes", async () => {
    await expect(openUrl("file:///etc/hosts")).rejects.toThrow("Only http and https links")
    await expect(openUrl("javascript:alert(1)")).rejects.toThrow("Only http and https links")
    await expect(openUrl("ms-msdt:/id PCWDiagnostic")).rejects.toThrow("Only http and https links")
    await expect(openUrl("\\\\server\\share\\file.html")).rejects.toThrow("Only http and https links")
  })
})

describe("resolveOpenTarget", () => {
  test("keeps http and https URLs for the browser", () => {
    expect(resolveOpenTarget("https://example.com/docs")).toBe("https://example.com/docs")
    expect(resolveOpenTarget("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096/")
  })

  test("maps local file URLs and absolute paths to filesystem paths", () => {
    const file = path.join(path.resolve("/tmp"), "example.md")
    expect(resolveOpenTarget(pathToFileURL(file).href)).toBe(file)
    expect(resolveOpenTarget(file)).toBe(file)
  })

  test("rejects remote file URLs and unsafe schemes", () => {
    expect(resolveOpenTarget("file://example.com/share/index.html")).toBeUndefined()
    expect(resolveOpenTarget("javascript:alert(1)")).toBeUndefined()
    expect(resolveOpenTarget("packages/tui/src/ui/link.tsx")).toBeUndefined()
    expect(resolveOpenTarget("not a url")).toBeUndefined()
  })
})
