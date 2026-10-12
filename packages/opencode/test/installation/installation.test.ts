import { describe, expect, test } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

// A handler that returns undefined never responds.
function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response | undefined) {
  const client = HttpClient.make((request) => {
    const response = handler(request)
    return response ? Effect.succeed(HttpClientResponse.fromWeb(request, response)) : Effect.never
  })
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response | undefined,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  describe("isUpdate", () => {
    test("only counts newer releases in the installed major version", () => {
      expect(Installation.isUpdate("1.19.0", "1.19.1")).toBe(true)
      expect(Installation.isUpdate("1.19.0", "1.20.0")).toBe(true)
      expect(Installation.isUpdate("1.19.0", "1.19.0")).toBe(false)
      expect(Installation.isUpdate("1.19.0", "1.18.35")).toBe(false)
      expect(Installation.isUpdate("1.19.0", "2.0.0")).toBe(false)
      expect(Installation.isUpdate("1.9.0", "1.10.0")).toBe(true)
    })

    test("compares preview builds within their channel", () => {
      expect(Installation.isUpdate("0.0.0-dev-202610110139", "0.0.0-dev-202610120000")).toBe(true)
      expect(Installation.isUpdate("0.0.0-dev-202610120000", "0.0.0-dev-202610110139")).toBe(false)
    })

    test("source builds only accept OpenCode 1 releases", () => {
      expect(Installation.isUpdate("local", "1.19.0")).toBe(true)
      expect(Installation.isUpdate("local", "2.0.0")).toBe(false)
      expect(Installation.isUpdate("1.19.0", "not-a-version")).toBe(false)
    })
  })

  describe("latest", () => {
    const service = `${Installation.UPDATE_URL}?current=${InstallationVersion}`
    const npm = "https://registry.npmjs.org/opencode-ai/latest"

    for (const method of ["curl", "yarn", "unknown"] as const) {
      const calls: string[] = []
      testEffect(
        testLayer((request) => {
          calls.push(request.url)
          return jsonResponse({ version: "1.19.1" })
        }),
      ).effect(`reads ${method} versions from the update service v1 channel`, () =>
        Effect.gen(function* () {
          calls.length = 0
          expect(yield* Installation.use.latest(method)).toBe("1.19.1")
          expect(calls).toEqual([service])
        }),
      )
    }

    const fallbackCalls: string[] = []
    testEffect(
      testLayer((request) => {
        fallbackCalls.push(request.url)
        if (request.url.startsWith(Installation.UPDATE_URL)) return new Response("unavailable", { status: 503 })
        return jsonResponse({ version: "1.19.2" })
      }),
    ).effect("falls back to the npm registry when the update service fails", () =>
      Effect.gen(function* () {
        fallbackCalls.length = 0
        expect(yield* Installation.use.latest("curl")).toBe("1.19.2")
        expect(fallbackCalls.at(-1)).toBe(npm)
        expect(fallbackCalls.some((url) => url.includes("api.github.com"))).toBe(false)
      }),
    )

    testEffect(
      testLayer((request) =>
        request.url.startsWith(Installation.UPDATE_URL) ? undefined : jsonResponse({ version: "1.19.4" }),
      ),
    ).effect("falls back to the npm registry when the update service times out", () =>
      Effect.gen(function* () {
        const fiber = yield* Installation.use.latest("curl").pipe(Effect.forkChild)
        yield* TestClock.adjust("10 seconds")
        expect(yield* Fiber.join(fiber)).toBe("1.19.4")
      }),
    )

    const invalidCalls: string[] = []
    testEffect(
      testLayer((request) => {
        invalidCalls.push(request.url)
        if (request.url.startsWith(Installation.UPDATE_URL)) return jsonResponse({ error: "Channel not found" })
        return jsonResponse({ version: "1.19.3" })
      }),
    ).effect("falls back to the npm registry when the update service has no v1 release", () =>
      Effect.gen(function* () {
        invalidCalls.length = 0
        expect(yield* Installation.use.latest("curl")).toBe("1.19.3")
        expect(invalidCalls.at(-1)).toBe(npm)
      }),
    )

    testEffect(testLayer(() => jsonResponse({ version: "2.0.27" }))).effect(
      "ignores OpenCode 2 releases from the update service",
      () =>
        Effect.gen(function* () {
          expect(yield* Installation.use.latest("curl")).toBe(InstallationVersion)
        }),
    )

    for (const method of ["npm", "bun", "pnpm"] as const) {
      const calls: string[] = []
      testEffect(
        testLayer((request) => {
          calls.push(request.url)
          return jsonResponse({ version: "1.5.0" })
        }),
      ).effect(`reads ${method} versions via registry`, () =>
        Effect.gen(function* () {
          calls.length = 0
          expect(yield* Installation.use.latest(method)).toBe("1.5.0")
          expect(calls).toEqual([npm])
        }),
      )

      testEffect(testLayer(() => jsonResponse({ version: "2.0.0" }))).effect(
        `ignores OpenCode 2 releases from ${method}`,
        () =>
          Effect.gen(function* () {
            expect(yield* Installation.use.latest(method)).toBe(InstallationVersion)
          }),
      )
    }

    testEffect(testLayer(() => jsonResponse({ version: "1.3.4" }))).effect("reads scoop manifest versions", () =>
      Effect.gen(function* () {
        expect(yield* Installation.use.latest("scoop")).toBe("1.3.4")
      }),
    )

    testEffect(testLayer(() => jsonResponse({ version: "2.3.4" }))).effect(
      "ignores OpenCode 2 releases from scoop",
      () =>
        Effect.gen(function* () {
          expect(yield* Installation.use.latest("scoop")).toBe(InstallationVersion)
        }),
    )

    testEffect(testLayer(() => jsonResponse({ d: { results: [{ Version: "1.4.5" }] } }))).effect(
      "reads chocolatey feed versions",
      () =>
        Effect.gen(function* () {
          expect(yield* Installation.use.latest("choco")).toBe("1.4.5")
        }),
    )

    testEffect(testLayer(() => jsonResponse({ d: { results: [{ Version: "2.0.0" }] } }))).effect(
      "ignores OpenCode 2 releases from chocolatey",
      () =>
        Effect.gen(function* () {
          expect(yield* Installation.use.latest("choco")).toBe(InstallationVersion)
        }),
    )

    const brewCore = (cmd: string, args: readonly string[]) => {
      // getBrewFormula: return core formula (no tap)
      if (cmd === "brew" && args.includes("--formula") && args.includes("anomalyco/tap/opencode")) return ""
      if (cmd === "brew" && args.includes("--formula") && args.includes("opencode")) return "opencode"
      return ""
    }
    testEffect(testLayer(() => jsonResponse({ versions: { stable: "1.8.0" } }), brewCore)).effect(
      "reads brew formulae API versions",
      () =>
        Effect.gen(function* () {
          expect(yield* Installation.use.latest("brew")).toBe("1.8.0")
        }),
    )

    testEffect(testLayer(() => jsonResponse({ versions: { stable: "2.0.25" } }), brewCore)).effect(
      "ignores OpenCode 2 in Homebrew Core",
      () =>
        Effect.gen(function* () {
          expect(yield* Installation.use.latest("brew")).toBe(InstallationVersion)
        }),
    )

    const brewTap = (stable: string) => (cmd: string, args: readonly string[]) => {
      if (cmd === "brew" && args.includes("anomalyco/tap/opencode") && args.includes("--formula")) return "opencode"
      if (cmd === "brew" && args.includes("--json=v2")) return JSON.stringify({ formulae: [{ versions: { stable } }] })
      return ""
    }
    // HTTP is not used for the tap formula.
    testEffect(testLayer(() => jsonResponse({}), brewTap("1.9.0"))).effect("reads brew tap info JSON via CLI", () =>
      Effect.gen(function* () {
        expect(yield* Installation.use.latest("brew")).toBe("1.9.0")
      }),
    )

    testEffect(testLayer(() => jsonResponse({}), brewTap("2.1.0"))).effect(
      "ignores OpenCode 2 in the Homebrew tap",
      () =>
        Effect.gen(function* () {
          expect(yield* Installation.use.latest("brew")).toBe(InstallationVersion)
        }),
    )
  })

  describe("upgrade", () => {
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => {
          if (cmd === "npm") return { code: 1, stderr: "token=secret command output" }
          return ""
        },
      ),
    ).effect("returns sanitized typed errors for failed package upgrades", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("npm", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Upgrade failed for npm (exit code 1).")
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
        expect(error.stderr).not.toContain("command output")
      }),
    )

    testEffect(
      testLayer(
        () => new Response("install script with token=secret", { status: 200 }),
        (cmd, args) => {
          if (cmd === "bash" && args[0] === "--version") return "GNU bash"
          if (cmd === "bash" || cmd === "sh") return { code: 1, stderr: "script output with token=secret" }
          return ""
        },
      ),
    ).effect("returns sanitized typed errors when the curl install script fails", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("curl", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Upgrade failed for curl (exit code 1).")
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
        expect(error.stderr).not.toContain("script output")
      }),
    )

    testEffect(
      testLayer(
        () => new Response("install script", { status: 200 }),
        (cmd, args) => {
          if (cmd === "bash" && args[0] === "--version") return { code: 1, stderr: "missing" }
          if (cmd === "bash") return { code: 1, stderr: "should not execute installer with bash" }
          if (cmd === "sh") return "ok"
          return ""
        },
      ),
    ).effect("falls back to sh when bash is unavailable during curl upgrade", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("curl", "9.9.9")
      }),
    )
  })

  describe("upgradeMajor", () => {
    const calls: string[] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          calls.push([cmd, ...args].join(" "))
          return ""
        },
      ),
    ).effect("replaces the npm package with OpenCode 2", () =>
      Effect.gen(function* () {
        calls.length = 0
        yield* Installation.use.upgradeMajor("npm")
        expect(calls.slice(0, 2)).toEqual(["npm uninstall -g opencode-ai", "npm install -g @opencode/cli"])
      }),
    )

    const restoreCalls: string[] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          restoreCalls.push([cmd, ...args].join(" "))
          if (args.includes("@opencode/cli")) return { code: 1, stderr: "install failed" }
          return ""
        },
      ),
    ).effect("restores OpenCode 1 when the OpenCode 2 install fails", () =>
      Effect.gen(function* () {
        restoreCalls.length = 0
        const error = yield* Effect.flip(Installation.use.upgradeMajor("npm"))
        expect(error.stderr).toBe("Upgrade failed for npm (exit code 1).")
        expect(restoreCalls[2]).toMatch(/^npm install -g opencode-ai@/)
      }),
    )

    const brewCalls: string[] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          brewCalls.push([cmd, ...args].join(" "))
          if (args.join(" ") === "list --formula anomalyco/tap/opencode") return "opencode"
          return ""
        },
      ),
    ).effect("replaces the brew formula with the OpenCode 2 formula", () =>
      Effect.gen(function* () {
        brewCalls.length = 0
        yield* Installation.use.upgradeMajor("brew")
        expect(brewCalls).toContain("brew uninstall anomalyco/tap/opencode")
        expect(brewCalls).toContain("brew install anomalyco/tap/opencode-v2")
      }),
    )

    const curlCalls: string[] = []
    const curlUrls: string[] = []
    testEffect(
      testLayer(
        (request) => {
          curlUrls.push(request.url)
          return new Response("echo v2", { status: 200 })
        },
        (cmd, args) => {
          curlCalls.push(cmd)
          if (cmd === "bash" && args[0] === "--version") return "GNU bash"
          return ""
        },
      ),
    ).effect("runs the OpenCode 2 install script for curl installs", () =>
      Effect.gen(function* () {
        curlUrls.length = 0
        yield* Installation.use.upgradeMajor("curl")
        expect(curlUrls).toEqual(["https://opencode.ai/v2/install"])
        expect(curlCalls).toContain("bash")
      }),
    )

    const chocoCalls: string[] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => {
          chocoCalls.push(cmd)
          return ""
        },
      ),
    ).effect("leaves package managers without OpenCode 2 untouched", () =>
      Effect.gen(function* () {
        chocoCalls.length = 0
        const error = yield* Effect.flip(Installation.use.upgradeMajor("choco"))
        expect(error.stderr).toContain(Installation.MAJOR_INSTRUCTIONS)
        expect(chocoCalls).toEqual([])
      }),
    )
  })
})
