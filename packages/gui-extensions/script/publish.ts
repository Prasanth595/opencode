#!/usr/bin/env bun

// Publishes the GUI extension SDK that plugin `./gui` bundles build against. The app provides these modules at
// runtime, so the package ships the SDK's sources and declarations for authors' types only. The built-in extensions
// stay unpublished.

import { Script } from "@opencode/script"
import { $ } from "bun"
import { rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"

process.chdir(fileURLToPath(new URL("..", import.meta.url)))

const original = await Bun.file("package.json").text()

// SAFETY: this is the package's own package.json, which declares its name, version, string exports and dependencies.
const pkg = JSON.parse(original) as {
  name: string
  version: string
  exports: Record<string, string>
  dependencies: Record<string, string>
}

if ((await $`npm view ${pkg.name}@${pkg.version} version`.nothrow()).exitCode === 0) {
  console.log(`already published ${pkg.name}@${pkg.version}`)
  process.exit(0)
}

const entries = ["./sdk", "./sdk/main", "./file", "./review", "./browser", "./updater"]

const tarball = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`

await rm("dist", { recursive: true, force: true })

await $`bunx tsgo -p tsconfig.build.json`

const published = {
  name: pkg.name,
  version: pkg.version,
  description: "Types for OpenCode GUI extensions, the `./gui` entry of an OpenCode plugin",
  type: "module",
  license: "MIT",
  repository: {
    type: "git",
    url: "git+https://github.com/anomalyco/opencode.git",
    directory: "packages/gui-extensions",
  },
  publishConfig: { access: "public" },
  files: [
    "dist/**/*.d.ts",
    "src/sdk/*.ts",
    "!src/sdk/*.test.ts",
    "!src/sdk/*.typecheck.ts",
    "!src/sdk/bridge.ts",
    "src/{file,review,browser,updater}/contract.ts",
  ],
  exports: Object.fromEntries(
    entries.map((entry) => [
      entry,
      { types: pkg.exports[entry].replace("./src/", "./dist/").replace(/\.ts$/, ".d.ts"), import: pkg.exports[entry] },
    ]),
  ),
  dependencies: Object.fromEntries(
    ["effect", "@opencode/client", "@opencode/ui", "@opencode/util"].map((name) => [name, pkg.dependencies[name]]),
  ),
  peerDependencies: { "solid-js": "^1.9.0", electron: "*" },
  peerDependenciesMeta: { electron: { optional: true } },
}

await Bun.write("package.json", JSON.stringify(published, null, 2) + "\n")

try {
  await $`bun pm pack`

  if (process.argv.includes("--dry-run")) await $`tar -xOzf ${tarball} package/package.json`
  else await $`npm publish ${tarball} --access public --tag ${Script.channel}`
} finally {
  await Bun.write("package.json", original)
  await rm(tarball, { force: true })
}
