import { expect, test } from "bun:test"
import { lstat, readdir, readlink, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { migrateV1, resolveThemeDocument } from "../../packages/theme/src/tui/index.js"
import type { ThemeV1Json } from "../../packages/theme/src/tui/v1.js"
import { createColors, deriveInactiveColor, deriveTrailColors } from "../../packages/tui/src/ui/spinner.js"

const root = join(import.meta.dir, "../..")
const source: ThemeV1Json = await Bun.file(join(root, "packages/tui/src/theme/assets/opencode.json")).json()

// Run against the installed Nix dependency tree, including after relocation.
test.each(["light", "dark"] as const)("theme colors survive spinner conversion in %s mode", (mode) => {
  const color = resolveThemeDocument(migrateV1(source), mode).hue.accent[800]
  const trail = deriveTrailColors(color)
  expect([trail[0].r, trail[0].g, trail[0].b, trail[0].a]).toEqual([color.r, color.g, color.b, 1])
  const inactive = deriveInactiveColor(color, 0.2)
  expect([inactive.r, inactive.g, inactive.b]).toEqual([color.r, color.g, color.b])
  expect(inactive.a).toBeCloseTo(0.2, 2)
  const frame = createColors({ colors: [color], defaultColor: color, enableFading: false })(0, 7, 54, 8)
  expect(frame).toEqual(color)
})

test("OpenTUI consumers resolve one runtime entrypoint", async () => {
  const paths = await Promise.all(
    ["theme", "tui", "cli", "merman", "latex", "plugin", "simulation"].map((workspace) =>
      realpath(Bun.resolveSync("@opentui/core", join(root, "packages", workspace))),
    ),
  )
  expect(new Set(paths).size).toBe(1)
  const solid = Bun.resolveSync("@opentui/solid", join(root, "packages/tui"))
  const spinner = Bun.resolveSync("opentui-spinner", join(root, "packages/tui"))
  expect(await realpath(Bun.resolveSync("@opentui/core", dirname(solid)))).toBe(paths[0])
  expect(await realpath(Bun.resolveSync("@opentui/core", dirname(spinner)))).toBe(paths[0])
})

test.each([
  ["@ai-sdk/provider-utils", "zod"],
  ["@opentelemetry/core", "@opentelemetry/api"],
])("%s retains incompatible %s peer contexts", async (name, peer) => {
  const store = join(root, "node_modules/.bun")
  const entries = (await readdir(store)).filter((entry) => entry.startsWith(name.replaceAll("/", "+") + "@"))
  const contexts = new Map<string, Set<string>>()
  for (const entry of entries) {
    const dir = join(store, entry, "node_modules", name)
    const manifest = await Bun.file(join(dir, "package.json")).json()
    const dependency = await realpath(Bun.resolveSync(peer + "/package.json", dir))
    const versions = contexts.get(manifest.version) ?? new Set<string>()
    versions.add((await Bun.file(dependency).json()).version)
    contexts.set(manifest.version, versions)
  }
  expect([...contexts.values()].some((versions) => versions.size > 1)).toBe(true)
})

test("installed dependency links remain relative and internal after copying", async () => {
  const store = join(root, "node_modules/.bun")
  const modules = [
    join(root, "node_modules"),
    ...(await readdir(store)).filter((entry) => entry !== "node_modules").map((entry) => join(store, entry, "node_modules")),
    join(store, "node_modules"),
    ...["theme", "tui", "cli", "merman", "latex", "plugin", "simulation"].map((name) =>
      join(root, "packages", name, "node_modules"),
    ),
  ]
  for (const dir of modules) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const paths = entry.name.startsWith("@") && entry.isDirectory()
        ? (await readdir(path)).map((name) => join(path, name))
        : [path]
      for (const link of paths) {
        if (!(await lstat(link)).isSymbolicLink()) continue
        expect(isAbsolute(await readlink(link))).toBe(false)
        expect(await realpath(link)).toStartWith(root + "/")
      }
    }
  }
})
