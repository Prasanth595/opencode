import type { MouseEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"

const LEFT_MOUSE_BUTTON = 0

// Mouse handlers that run an action on a plain left click. A press dragged off
// its cell, or one that ended up selecting text, is a selection rather than a
// click, so drag-to-select keeps working on the same element.
export function onClick(run: () => void) {
  const renderer = useRenderer()
  let press: { x: number; y: number } | undefined
  return {
    onMouseDown: (event: MouseEvent) => {
      press = event.button === LEFT_MOUSE_BUTTON ? { x: event.x, y: event.y } : undefined
    },
    onMouseUp: (event: MouseEvent) => {
      const same = press?.x === event.x && press.y === event.y
      press = undefined
      if (!same || renderer.getSelection()?.getSelectedText()) return
      run()
    },
  }
}
