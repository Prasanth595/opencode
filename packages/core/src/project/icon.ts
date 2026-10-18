export * as ProjectIcon from "./icon.js"

import path from "path"
import { Effect, Option, Schema } from "effect"
import { parse } from "jsonc-parser"
import { FSUtil } from "@opencode/util/fs-util"
import { Hash } from "@opencode/util/hash"
import { AbsolutePath } from "../schema.js"

/** Largest image discovery considers or serves. */
export const MAX_BYTES = 1024 * 1024
/** Directory levels below the root that discovery lists. */
export const MAX_DEPTH = 4
const MAX_DIRECTORIES = 500

/** Lower ranks win; within a rank SVGs and larger square rasters win, then shallower paths. */
export const Rank = { config: 0, app: 1, desktop: 2, web: 3, logo: 4 } as const

export type Candidate =
  | { readonly type: "url"; readonly url: string; readonly rank: number }
  | {
      readonly type: "file"
      readonly file: AbsolutePath
      /** Posix path relative to the discovery root. */
      readonly path: string
      readonly rank: number
    }

export interface Image {
  readonly bytes: Uint8Array
  readonly type: string
  /** Content hash used to version icon URLs. */
  readonly hash: string
}

const IMAGES = new Set([".svg", ".png", ".ico", ".jpg", ".jpeg", ".webp"])
const CONFIGS = ["opencode.jsonc", "opencode.json", ".opencode/opencode.jsonc", ".opencode/opencode.json"]
// Dependency, generated, vendored, and fixture trees. A `build` directory is never listed, but its Electron icon
// is probed.
const SKIP = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "out",
  "target",
  "coverage",
  "tmp",
  "pods",
  "carthage",
  "deriveddata",
  "__pycache__",
  "artifacts",
  "examples",
  "fixtures",
  "__fixtures__",
  "test",
  "tests",
  "__tests__",
])
const decodeConfig = Schema.decodeUnknownOption(Schema.Struct({ icon: Schema.String }))
const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      groups: Schema.Array(
        Schema.Struct({ layers: Schema.Array(Schema.Struct({ "image-name": Schema.optional(Schema.String) })) }),
      ),
    }),
  ),
)
const LOGO_PLACES = new Set(["assets", "public", "static", "images", "img", "media", "resources", "docs", ".github"])

/** Ranked icon candidates under `root`, best first. Bounded by depth, directory count, and file size. */
export const discover = Effect.fn("ProjectIcon.discover")(function* (
  fs: FSUtil.Interface,
  root: AbsolutePath,
): Effect.fn.Return<readonly Candidate[]> {
  const configured = yield* config(fs, root)
  const found = yield* walk(fs, root)
  const scored = yield* Effect.forEach(found, (item) =>
    (item.score === undefined ? measure(fs, path.join(root, ...item.segments)) : Effect.succeed(item.score)).pipe(
      Effect.map((score) => (score === undefined ? [] : [{ ...item, score }])),
    ),
  )
  const files = scored
    .flat()
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        b.score - a.score ||
        a.segments.length - b.segments.length ||
        a.segments.join("/").localeCompare(b.segments.join("/")),
    )
    .map((item) => ({
      type: "file" as const,
      file: AbsolutePath.make(path.join(root, ...item.segments)),
      path: item.segments.join("/"),
      rank: item.rank,
    }))
  if (!configured) return files
  return [configured, ...files.filter((item) => configured.type !== "file" || item.file !== configured.file)]
})

/** Reads a discovered file for serving, or nothing when it is missing, too large, or not an image. */
export const read = Effect.fn("ProjectIcon.read")(function* (
  fs: FSUtil.Interface,
  file: string,
): Effect.fn.Return<Image | undefined> {
  const type = mime(file)
  if (!type) return undefined
  const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined))
  if (!info || info.type !== "File" || !Number(info.size) || Number(info.size) > MAX_BYTES) return undefined
  const bytes = yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => undefined))
  if (!bytes) return undefined
  return { bytes, type, hash: Hash.fast(Buffer.from(bytes)).slice(0, 16) }
})

export function mime(file: string) {
  const extension = path.extname(file).toLowerCase()
  if (!IMAGES.has(extension)) return undefined
  if (extension === ".ico") return "image/x-icon"
  return FSUtil.mimeType(file)
}

const config = Effect.fnUntraced(function* (fs: FSUtil.Interface, root: AbsolutePath) {
  for (const name of CONFIGS) {
    const text = yield* fs.readFileString(path.join(root, name)).pipe(Effect.orElseSucceed(() => undefined))
    if (text === undefined) continue
    const value = Option.getOrUndefined(decodeConfig(parse(text)))?.icon.trim()
    if (!value) continue
    if (/^(https?:|data:image\/)/i.test(value)) return { type: "url", url: value, rank: Rank.config } as const
    const file = path.resolve(root, path.dirname(name), value)
    if (!FSUtil.contains(root, file) || !(yield* read(fs, file))) continue
    return {
      type: "file",
      file: AbsolutePath.make(file),
      path: path.relative(root, file).split(path.sep).join("/"),
      rank: Rank.config,
    } as const
  }
})

interface Found {
  readonly segments: readonly string[]
  readonly rank: number
  /** Known for bundle images, which are measured or chosen while listing the bundle. */
  readonly score?: number
}

const walk = Effect.fnUntraced(function* (fs: FSUtil.Interface, root: AbsolutePath) {
  const found: Found[] = []
  const queue: string[][] = [[]]
  let visited = 0
  while (queue.length && visited < MAX_DIRECTORIES) {
    const directory = queue.shift() ?? []
    visited++
    const entries = yield* fs
      .readDirectoryEntries(path.join(root, ...directory))
      .pipe(Effect.orElseSucceed((): FSUtil.DirEntry[] => []))
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const name = entry.name.toLowerCase()
      const segments = [...directory, entry.name]
      if (entry.type === "file") {
        const rank = classify(directory, name)
        if (rank !== undefined) found.push({ segments, rank })
        continue
      }
      if (entry.type !== "directory") continue
      if (name.endsWith(".appiconset") || name.endsWith(".icon")) {
        const image = yield* bundle(fs, root, segments)
        if (image) found.push({ ...image, rank: Rank.app })
        continue
      }
      if (name === "build") {
        found.push(...["icon.svg", "icon.png"].map((file) => ({ segments: [...segments, file], rank: Rank.desktop })))
        continue
      }
      if (SKIP.has(name) || (name.startsWith(".") && name !== ".github")) continue
      if (segments.length <= MAX_DEPTH) queue.push(segments)
    }
  }
  return found
})

function classify(directory: readonly string[], name: string) {
  const extension = path.extname(name)
  if (!IMAGES.has(extension)) return undefined
  const base = name.slice(0, -extension.length)
  const parent = directory.at(-1)?.toLowerCase() ?? ""
  if (/^app[-_]?icon$/.test(base)) return Rank.app
  if (parent === "icons" && directory.at(-2)?.toLowerCase() === "src-tauri") return Rank.desktop
  if (base === "icon" && (parent === "resources" || parent === "icons")) return Rank.desktop
  if (base.startsWith("favicon") || base.startsWith("apple-touch-icon")) return Rank.web
  if ((base === "icon" || base === "apple-icon") && parent === "app") return Rank.web
  if ((base === "logo" || base === "icon") && (directory.length === 0 || LOGO_PLACES.has(parent))) return Rank.logo
  return undefined
}

// An Xcode `.appiconset` holds rendered sizes; the largest wins. An Icon Composer `.icon` holds layers in
// Assets/, named front to back in icon.json; its front layer is used, ranked below rendered app icons.
const bundle = Effect.fnUntraced(function* (fs: FSUtil.Interface, root: AbsolutePath, segments: readonly string[]) {
  if (!segments.at(-1)?.toLowerCase().endsWith(".icon")) {
    const entries = yield* fs
      .readDirectoryEntries(path.join(root, ...segments))
      .pipe(Effect.orElseSucceed((): FSUtil.DirEntry[] => []))
    const scored = yield* Effect.forEach(
      entries.filter((entry) => entry.type === "file" && IMAGES.has(path.extname(entry.name).toLowerCase())),
      (entry) =>
        measure(fs, path.join(root, ...segments, entry.name)).pipe(
          Effect.map((score) => ({ segments: [...segments, entry.name], score: score ?? -1 })),
        ),
    )
    return scored.filter((item) => item.score >= 0).toSorted((a, b) => b.score - a.score)[0]
  }
  const manifest = yield* fs
    .readFileString(path.join(root, ...segments, "icon.json"))
    .pipe(Effect.orElseSucceed(() => undefined))
  const layer = Option.getOrUndefined(decodeManifest(manifest))
    ?.groups.flatMap((group) => group.layers.flatMap((item) => item["image-name"] ?? []))
    .at(0)
  if (!layer || !(yield* read(fs, path.join(root, ...segments, "Assets", layer)))) return undefined
  return { segments: [...segments, "Assets", layer], score: 0 }
})

// SVGs scale to any size; rasters score by their shorter side, halved when not square.
const measure = Effect.fnUntraced(function* (fs: FSUtil.Interface, file: string) {
  const image = yield* read(fs, file)
  if (!image) return undefined
  if (image.type === "image/svg+xml") return Number.MAX_SAFE_INTEGER
  const size = png(image.bytes)
  if (!size) return image.type === "image/x-icon" ? 32 : 64
  const side = Math.min(size.width, size.height)
  return size.width === size.height ? side : side / 2
})

function png(bytes: Uint8Array) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47)
    return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
