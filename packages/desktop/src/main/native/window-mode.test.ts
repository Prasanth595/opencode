import { describe, expect, test } from "bun:test"
import { toggleWindowMode } from "./window-mode"

describe("window mode", () => {
  test("macOS keeps native fullscreen", () => {
    expect(toggleWindowMode("darwin", { fullscreen: false, maximized: false })).toBe("enter-fullscreen")
    expect(toggleWindowMode("darwin", { fullscreen: true, maximized: false })).toBe("leave-fullscreen")
  })

  test("Windows maximizes instead of covering the taskbar", () => {
    expect(toggleWindowMode("win32", { fullscreen: false, maximized: false })).toBe("maximize")
    expect(toggleWindowMode("win32", { fullscreen: false, maximized: true })).toBe("restore")
    expect(toggleWindowMode("win32", { fullscreen: true, maximized: false })).toBe("leave-fullscreen")
  })

  test("other platforms keep native fullscreen", () => {
    expect(toggleWindowMode("linux", { fullscreen: false, maximized: false })).toBe("enter-fullscreen")
    expect(toggleWindowMode("linux", { fullscreen: true, maximized: true })).toBe("leave-fullscreen")
  })
})
