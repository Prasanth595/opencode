/** @jsxImportSource @opentui/solid */
import { BoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider, useTheme } from "../../src/context/theme"
import { createPaneResize } from "../../src/ui/pane-resize"
import { PaneResizeHandle } from "../../src/ui/pane-resize-handle"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

for (const mode of ["dark", "light"] as const) {
  test(`${mode} pane resize handle renders themed hover, resize pointer and grip and keeps parent-owned dragging and reset`, async () => {
    const [value, setValue] = createSignal(20)
    const commits: number[] = []
    let resize!: ReturnType<typeof createPaneResize>
    let theme!: ReturnType<typeof useTheme>
    let parent!: BoxRenderable
    function Pane() {
      theme = useTheme()
      resize = createPaneResize({
        value,
        defaultValue: () => 16,
        clamp: (size) => Math.max(10, Math.min(40, size)),
        fromMouse: (event) => event.x + 1,
        contains: (event, size) => event.x >= size - 1 && event.x <= size,
        onCommit: (size) => {
          commits.push(size)
          setValue(size)
        },
      })
      return (
        <box
          ref={(element) => (parent = element)}
          width="100%"
          height="100%"
          onMouseDrag={resize.onMouseDrag}
          onMouseDragEnd={resize.onMouseDragEnd}
          onMouseUp={resize.onMouseUp}
        >
          <PaneResizeHandle resize={resize} left={resize.size() - 1} />
        </box>
      )
    }
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig({ theme: { name: "opencode", mode } })}>
            <ThemeProvider mode={mode} source={emptyThemeSource}>
              <Pane />
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 60, height: 5 },
    )

    const pointers: string[] = []
    // Where the grip mark is drawn, as [column, row] pairs.
    const grips = () =>
      app
        .captureCharFrame()
        .split("\n")
        .flatMap((row, y) => [...row].flatMap((char, x) => (char === "⋮" ? [[x, y]] : [])))
    app.renderer.setMousePointer = (style) => pointers.push(style)

    try {
      app.renderer.start()
      await app.waitForFrame(() => parent?.height === 5)
      const handle = parent.getChildren()[0] as BoxRenderable
      const line = handle.getChildren()[0] as BoxRenderable
      expect(handle).toMatchObject({ x: 19, y: 0, width: 2, height: 5, zIndex: 10 })
      expect(line).toMatchObject({ x: 19, y: 0, width: 1, height: 5 })
      expect(line.backgroundColor.a).toBe(0)
      expect(handle.backgroundColor.a).toBe(0)
      expect(pointers).toEqual([])
      expect(grips()).toEqual([])

      setValue(24)
      await app.renderOnce()
      expect(handle.x).toBe(23)
      expect(line.x).toBe(23)
      expect(commits).toEqual([])

      // The transparent second column is still part of the hitbox.
      await app.mockMouse.moveTo(24, 2)
      await app.renderOnce()
      expect(resize.hovered()).toBe(true)
      expect(resize.resizing()).toBe(false)
      expect(line.backgroundColor.toInts()).toEqual(theme.background.raised.high.toInts())
      expect(handle.backgroundColor.a).toBe(0)
      expect(pointers).toEqual(["ew-resize"])
      expect(grips()).toEqual([[23, 2]])
      await app.mockMouse.moveTo(24, 4)
      await app.renderOnce()
      expect(grips()).toEqual([[23, 4]])
      for (const row of app.captureSpans().lines) {
        const colors = row.spans.flatMap((span) => Array.from({ length: span.width }, () => span.bg.toInts()))
        expect(colors[23]).toEqual(theme.background.raised.high.toInts())
        expect(colors[24]).not.toEqual(colors[23])
      }

      await app.mockMouse.moveTo(5, 2)
      await app.renderOnce()
      expect(resize.hovered()).toBe(false)
      expect(line.backgroundColor.a).toBe(0)
      expect(pointers).toEqual(["ew-resize", "default"])
      expect(grips()).toEqual([])

      await app.mockMouse.pressDown(24, 2)
      expect(resize.resizing()).toBe(true)
      // The grip stays on the row the drag started from and moves with the divider.
      await app.mockMouse.moveTo(30, 1)
      await app.renderOnce()
      expect(grips()).toEqual([[30, 2]])
      expect(resize.size()).toBe(31)
      expect(handle.x).toBe(30)
      expect(line.x).toBe(30)
      expect(commits).toEqual([])

      // Clamping leaves the pointer outside the handle while the parent keeps dragging.
      await app.mockMouse.moveTo(50, 2)
      await app.renderOnce()
      expect(resize.size()).toBe(40)
      expect(handle.x).toBe(39)
      expect(resize.hovered()).toBe(false)
      expect(resize.resizing()).toBe(true)
      expect(line.backgroundColor.toInts()).toEqual(theme.background.raised.high.toInts())
      expect(pointers.at(-1)).toBe("ew-resize")
      expect(grips()).toEqual([[39, 2]])
      expect(line.getChildren()[0]).toMatchObject({ fg: theme.text.action.primary.base })
      expect(commits).toEqual([])

      await app.mockMouse.release(55, 2)
      await app.renderOnce()
      expect(resize.resizing()).toBe(false)
      expect(resize.hovered()).toBe(false)
      expect(line.backgroundColor.a).toBe(0)
      expect(value()).toBe(40)
      expect(commits).toEqual([40])
      expect(pointers).toEqual(["ew-resize", "default", "ew-resize", "default"])
      expect(grips()).toEqual([])

      await app.mockMouse.doubleClick(40, 2)
      await app.renderOnce()
      expect(value()).toBe(16)
      expect(handle.x).toBe(15)
      expect(line.x).toBe(15)
      expect(resize.resizing()).toBe(false)
      expect(resize.hovered()).toBe(false)
      expect(line.backgroundColor.a).toBe(0)
      expect(commits).toEqual([40, 16])
      expect(pointers.at(-1)).toBe("default")
    } finally {
      app.renderer.destroy()
    }
  })
}
