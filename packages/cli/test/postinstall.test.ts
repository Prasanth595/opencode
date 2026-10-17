import { describe, expect, test } from "bun:test"
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const script = path.resolve(import.meta.dir, "../script/postinstall.mjs")

// `packageNames` also tries the libc and CPU variants of the running platform, so the package it picks first has to be
// the plain one, or the launcher installs a different name than the stand-ins below cover.
function target() {
  const platform =
    ({ darwin: "darwin", linux: "linux", win32: "windows" } as Record<string, string>)[process.platform] ??
    process.platform
  const arch = ({ x64: "x64", arm64: "arm64", arm: "arm" } as Record<string, string>)[process.arch] ?? process.arch
  return {
    name: `@opencode/cli-${platform}-${arch}`,
    executable: platform === "windows" ? "opencode.exe" : "opencode",
  }
}

// The launcher is a plain script that exits when it finishes, so each case runs a copy of it as a child process. The
// copy sits beside a package that names the running platform, and nothing in `bin/` yet, which is the state a fresh
// install starts from: the package is there but the copied binary is not, so the launcher has to install the package.
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-postinstall-")))
  const platform = target()
  const installed = path.join(root, "node_modules", platform.name)
  const directory = path.join(root, "script")
  fs.mkdirSync(path.join(installed, "bin"), { recursive: true })
  fs.mkdirSync(path.join(directory, "bin"), { recursive: true })
  fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: platform.name, version: "0.0.0" }))
  fs.writeFileSync(path.join(directory, "package.json"), packageFile(platform.name))
  return {
    root,
    directory,
    name: platform.name,
    executable: platform.executable,
    recorded: path.join(root, "npm-command.json"),
  }
}

function packageFile(name: string) {
  return JSON.stringify({
    name: "@opencode/cli",
    version: "0.0.0",
    opencodeSourceBinary: "opencode",
    bin: { opencode: "./bin/opencode" },
    optionalDependencies: { [name]: "0.0.0" },
  })
}

type Fixture = ReturnType<typeof fixture>

// Records which npm the launcher started, without npm running: the copy imports this module, whose `installPackage`
// replaces the launcher's own. An import is the one syntax the launcher file cannot carry yet, so every other line of
// the copy stays exactly as shipped.
function recordsName(files: Fixture) {
  const recorder = path.join(files.root, "recorder.mjs")
  const lines = [
    'import fs from "node:fs"',
    `const recorded = ${JSON.stringify(files.recorded)}`,
    "",
    "export function installPackage(name) {",
    "  fs.writeFileSync(recorded, JSON.stringify(name))",
    "  return true",
    "}",
  ]
  fs.writeFileSync(recorder, lines.join("\n") + "\n")
  const statement = `import { installPackage } from ${JSON.stringify(pathToFileURL(recorder).href)}`
  return (source: string) => {
    const [shebang, ...rest] = source.split(/\r?\n/)
    const shipped = rest
      .join("\n")
      .replace(/^function installPackage\(name\) \{/m, "function installsAsShipped(name) {")
    return [shebang, statement, shipped].join("\n")
  }
}

function launched(files: Fixture, source: string) {
  const launcher = path.join(files.directory, "postinstall.mjs")
  fs.writeFileSync(launcher, source)
  const result = childProcess.spawnSync(process.execPath, [launcher], {
    encoding: "utf8",
    env: { ...process.env, npm_execpath: "" },
  })
  const recorded = fs.existsSync(files.recorded) ? JSON.parse(fs.readFileSync(files.recorded, "utf8")) : undefined
  fs.rmSync(files.root, { recursive: true, force: true })
  return { result, recorded }
}

// Only Windows starts npm through Node, because npm's `.cmd` shim cannot be spawned directly there.
describe.skipIf(process.platform !== "win32")("npm command", () => {
  test("starts npm's CLI through node when npm_execpath is unset", () => {
    const files = fixture()
    const { recorded } = launched(files, recordsName(files)(fs.readFileSync(script, "utf8")))
    expect(recorded).toBe(files.name)
  })
})

test("reports why npm could not be started", () => {
  const files = fixture()
  // A Node path without npm beside it fails to spawn with ENOENT while the launcher itself still runs.
  const execPath = path.join(files.root, "node", "node")
  const source = fs
    .readFileSync(script, "utf8")
    .replace(/^const npm = .*$/m, `const npm = [${JSON.stringify(execPath)}, "npm-cli.js"]`)
  const { result } = launched(files, source)
  expect(result.stderr).toContain("npm could not be started: ENOENT")
  expect(result.status).toBe(1)
})
