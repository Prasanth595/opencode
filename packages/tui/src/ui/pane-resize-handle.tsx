import type { BoxRenderable, MouseEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js"
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
  const [row, setRow] = createSignal(0)
  let handle: BoxRenderable | undefined
  const follow = (event: MouseEvent) => setRow(event.y - (handle?.y ?? 0))

  // Show the terminal's resize pointer while hovering or dragging, as GUI split panes do.
  createEffect(on(active, (value) => renderer.setMousePointer(value ? "ew-resize" : "default"), { defer: true }))
  onCleanup(() => {
    if (active()) renderer.setMousePointer("default")
  })

  return (
    <box
      ref={(element) => (handle = element)}
      position="absolute"
      left={props.left}
      top={0}
      zIndex={10}
      width={2}
      height="100%"
      onMouseOver={(event) => {
        follow(event)
        props.resize.onMouseOver()
      }}
      onMouseMove={follow}
      onMouseOut={props.resize.onMouseOut}
      onMouseDown={(event) => {
        follow(event)
        props.resize.onMouseDown(event)
      }}
    >
      <box
        width={1}
        height="100%"
        marginLeft={props.highlight === "right" ? 1 : 0}
        backgroundColor={active() ? theme.background.raised.high : undefined}
      >
        {/* A grip mark beside the pointer, for terminals that cannot show the resize pointer. */}
        <Show when={active()}>
          <text position="absolute" top={row()} fg={theme.text.action.primary.base}>
            ⋮
          </text>
        </Show>
      </box>
    </box>
  )
}
