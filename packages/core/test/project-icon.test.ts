import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Project } from "@opencode/core/project"
import { ProjectIcon } from "@opencode/core/project/icon"
import { AbsolutePath } from "@opencode/core/schema"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))

describe("ProjectIcon.discover", () => {
  it.live("ranks app icons, desktop build icons, web icons, then logos", () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        "ios/App/Assets.xcassets/AppIcon.appiconset/icon-60.png": png(60),
        "ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png": png(1024),
        "ios/App/Assets.xcassets/AppIcon.appiconset/Contents.json": "{}",
        "build/icon.png": png(512),
        "build/output.png": png(512),
        "app/icon.png": png(256),
        "public/favicon.ico": "ico",
        "public/favicon.svg": "<svg/>",
        "assets/logo.png": png(128),
        "node_modules/package/favicon.svg": "<svg/>",
        ".cache/favicon.svg": "<svg/>",
        "src/screenshot.png": png(2048),
      })

      expect(yield* paths(root)).toEqual([
        "ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png",
        "build/icon.png",
        "public/favicon.svg",
        "app/icon.png",
        "public/favicon.ico",
        "assets/logo.png",
      ])
    }),
  )

  it.live("uses the front Icon Composer layer and ranks Tauri icons by size", () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        "src-tauri/icons/32x32.png": png(32),
        "src-tauri/icons/icon.png": png(512),
        "src-tauri/icons/wide.png": png(1024, 256),
        "mac/AppIcon.icon/icon.json": JSON.stringify({
          groups: [{ layers: [{ "image-name": "glyph.png" }] }, { layers: [{ "image-name": "glow.svg" }] }],
        }),
        "mac/AppIcon.icon/Assets/glyph.png": png(512),
        "mac/AppIcon.icon/Assets/glow.svg": "<svg/>",
      })

      expect(yield* paths(root)).toEqual([
        "mac/AppIcon.icon/Assets/glyph.png",
        "src-tauri/icons/icon.png",
        "src-tauri/icons/wide.png",
        "src-tauri/icons/32x32.png",
      ])
    }),
  )

  it.live("prefers a rendered app icon over an Icon Composer layer and skips fixtures", () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        "assets/AppIcon.icon/icon.json": JSON.stringify({ groups: [{ layers: [{ "image-name": "brush.png" }] }] }),
        "assets/AppIcon.icon/Assets/brush.png": png(1024),
        "assets/app-icon.png": png(1024),
        "test/fixtures/favicon.svg": "<svg/>",
      })

      expect(yield* paths(root)).toEqual(["assets/app-icon.png", "assets/AppIcon.icon/Assets/brush.png"])
    }),
  )

  it.live("puts an icon file from project config first", () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        "opencode.json": JSON.stringify({ icon: "./brand/mark.png" }),
        "brand/mark.png": png(64),
        "public/favicon.svg": "<svg/>",
      })

      expect(yield* paths(root)).toEqual(["brand/mark.png", "public/favicon.svg"])
    }),
  )

  it.live("accepts an icon URL from project config and ignores paths outside the project", () =>
    Effect.gen(function* () {
      const url = yield* fixture({
        ".opencode/opencode.jsonc": `{ // brand\n "icon": "https://example.com/icon.png" }`,
      })
      const outside = yield* fixture({ "opencode.json": JSON.stringify({ icon: "../elsewhere.png" }) })
      const fs = yield* FSUtil.Service

      expect(yield* ProjectIcon.discover(fs, url)).toEqual([
        { type: "url", url: "https://example.com/icon.png", rank: ProjectIcon.Rank.config },
      ])
      expect(yield* ProjectIcon.discover(fs, outside)).toEqual([])
    }),
  )

  it.live("skips files over the size cap and directories past the depth limit", () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        "public/favicon.png": new Uint8Array(ProjectIcon.MAX_BYTES + 1),
        "a/b/c/public/favicon.svg": "<svg/>",
        "a/b/c/d/public/favicon.svg": "<svg/>",
      })

      expect(yield* paths(root)).toEqual(["a/b/c/public/favicon.svg"])
    }),
  )
})

describe("Project.repositoryName", () => {
  test("uses the last remote path segment without .git", () => {
    expect(Project.repositoryName("git@github.com:kitlangton/team-board.git")).toBe("team-board")
    expect(Project.repositoryName("https://github.com/anomalyco/hex.git")).toBe("hex")
    expect(Project.repositoryName("https://github.com/anomalyco/hex")).toBe("hex")
    expect(Project.repositoryName("ssh://git@gitlab.com/group/subgroup/tool.git/")).toBe("tool")
    expect(Project.repositoryName("git@gitlab.example.com:group/nested/app")).toBe("app")
  })

  test("returns nothing for local remotes", () => {
    expect(Project.repositoryName("file:///tmp/repo.git")).toBeUndefined()
    expect(Project.repositoryName("")).toBeUndefined()
  })
})

function png(width: number, height = width) {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function fixture(files: Record<string, string | Uint8Array>) {
  return Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() =>
      Promise.all(Object.entries(files).map(([file, content]) => Bun.write(path.join(tmp.path, file), content))),
    )
    return AbsolutePath.make(tmp.path)
  })
}

function paths(root: AbsolutePath) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const candidates = yield* ProjectIcon.discover(fs, root)
    return candidates.map((candidate) => (candidate.type === "file" ? candidate.path : candidate.url))
  })
}
