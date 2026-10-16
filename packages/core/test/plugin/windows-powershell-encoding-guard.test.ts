import { describe, expect } from "bun:test"
import { WindowsPowershellEncodingGuardPlugin } from "@opencode/core/plugin/windows-powershell-encoding-guard"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect } from "effect"
import { it } from "../lib/effect"
import { host } from "./host"

describe("windows powershell encoding guard", () => {
  it.effect("appends the warning to the shell description, once", () =>
    Effect.sync(() => {
      const description = WindowsPowershellEncodingGuardPlugin.buildDescription("Runs commands.")
      expect(description.startsWith("Runs commands.")).toBe(true)
      expect(description).toContain(WindowsPowershellEncodingGuardPlugin.MARKER)
      expect(WindowsPowershellEncodingGuardPlugin.buildDescription(description)).toBe(description)
      expect(WindowsPowershellEncodingGuardPlugin.buildDescription(42)).toBe("")
    }),
  )

  it.effect("matches shell tool ids, namespaced ids, and the legacy bash alias", () =>
    Effect.sync(() => {
      expect(WindowsPowershellEncodingGuardPlugin.isShellToolId("shell")).toBe(true)
      expect(WindowsPowershellEncodingGuardPlugin.isShellToolId("mcp.server.Shell")).toBe(true)
      expect(WindowsPowershellEncodingGuardPlugin.isShellToolId("bash")).toBe(true)
      expect(WindowsPowershellEncodingGuardPlugin.isShellToolId("edit")).toBe(false)
      expect(WindowsPowershellEncodingGuardPlugin.isShellToolId("shellfish")).toBe(false)
      expect(WindowsPowershellEncodingGuardPlugin.isShellToolId(42)).toBe(false)
    }),
  )

  it.effect("registers a transform annotating the shell tool description", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const tool = { id: "shell", description: "Runs commands." }
      const editor = {
        list: () => [tool],
        get: (id: string) => (id === "shell" ? tool : undefined),
        namespace: () => {
          throw new Error("unused")
        },
        add: () => {
          throw new Error("unused")
        },
        update: (id: string, update: (value: { description: string }) => void) => {
          if (id === "shell") update(tool)
        },
        remove: () => {
          throw new Error("unused")
        },
      }
      const base = host()
      yield* WindowsPowershellEncodingGuardPlugin.Plugin.effect(
        host({
          tool: {
            ...base.tool,
            transform: (callback) =>
              Effect.sync(() => {
                callback(editor as unknown as ToolEditor)
                return { dispose: Effect.void }
              }),
          },
        }),
      )
      expect(tool.description).toContain(WindowsPowershellEncodingGuardPlugin.MARKER)
    }),
  )
})
