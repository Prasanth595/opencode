import { createHash } from "crypto"
import { describe, expect, test } from "bun:test"
import { displayName, getProjectAvatarSource, getProjectAvatarVariant } from "./project-avatar"

const discovered = { url: "/api/project/abc/icon?v=1" }

const resolve = (url: string) => (url === discovered.url ? "blob:icon" : undefined)

describe("getProjectAvatarSource", () => {
  test("prefers a chosen image, then a chosen color, then the discovered icon", () => {
    expect(getProjectAvatarSource("abc", { override: "data:image/png;base64,AA==", discovered }, resolve)).toBe(
      "data:image/png;base64,AA==",
    )
    expect(getProjectAvatarSource("abc", { color: "blue", discovered }, resolve)).toBeUndefined()
    expect(getProjectAvatarSource("abc", { discovered }, resolve)).toBe("blob:icon")
    expect(getProjectAvatarSource("abc", { discovered: { url: "https://example.com/icon.png" } })).toBe(
      "https://example.com/icon.png",
    )
    expect(getProjectAvatarSource("abc", { discovered, url: "data:legacy" })).toBe("data:legacy")
  })

  test("recognizes the OpenCode repository by its remote-derived project ID", () => {
    const id = createHash("sha1").update("git-remote:github.com/anomalyco/opencode").digest("hex")

    expect(getProjectAvatarSource(id)).toBe("https://opencode.ai/favicon.svg")
    expect(getProjectAvatarSource(id, { override: "data:custom" })).toBe("data:custom")
  })
})

describe("getProjectAvatarVariant", () => {
  test("keeps a chosen color and derives a stable non-gray color otherwise", () => {
    expect(getProjectAvatarVariant("blue", "abc")).toBe("blue")
    expect(getProjectAvatarVariant(undefined)).toBe("gray")
    expect(getProjectAvatarVariant(undefined, "abc")).toBe(getProjectAvatarVariant(undefined, "abc"))
    expect(
      new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((seed) => getProjectAvatarVariant(undefined, seed))),
    ).not.toContain("gray")
  })
})

describe("displayName", () => {
  test("uses a chosen name, then the repository name, then the folder", () => {
    expect(displayName({ name: "Board", repository: "team-board", worktree: "/src/rewrite" })).toBe("Board")
    expect(displayName({ repository: "team-board", worktree: "/src/rewrite" })).toBe("team-board")
    expect(displayName({ worktree: "/src/rewrite/" })).toBe("rewrite")
  })
})
