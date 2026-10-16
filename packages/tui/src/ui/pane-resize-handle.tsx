import { useRenderer } from "@opentui/solid"
import { createEffect, on, onCleanup } from "solid-js"
import { useTheme } from "../context/theme"
import type { createPaneResize } from "./pane-resize"

export function PaneResizeHandle(props: {
  resize: ReturnType<typeof createPaneResize>
  left: number
  highlight?: "left" | "right"
}) {
  const theme = useTheme()
  const renderer = useRenderer()
  const active = () => props.resize.hovered() || props.resize.resizing()

  // Show the terminal's resize pointer while hovering or dragging, as GUI split panes do.
  createEffect(on(active, (value) => renderer.setMousePointer(value ? "ew-resize" : "default"), { defer: true }))
  onCleanup(() => {
    if (active()) renderer.setMousePointer("default")
  })

  return (
    <box
      position="absolute"
      left={props.left}
      top={0}
      zIndex={10}
      width={2}
      height="100%"
      onMouseOver={props.resize.onMouseOver}
      onMouseOut={props.resize.onMouseOut}
      onMouseDown={props.resize.onMouseDown}
    >
      <box
        width={1}
        height="100%"
        marginLeft={props.highlight === "right" ? 1 : 0}
        backgroundColor={active() ? theme.background.raised.high : undefined}
      />
    </box>
  )
}
