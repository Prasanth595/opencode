import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createPanelMotion } from "../src/shell/panel-motion"

let frames: Map<number, FrameRequestCallback>

let id: number

let time: number

const cleanups: (() => void)[] = []

const originals = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame }

beforeEach(() => {
  frames = new Map()
  id = 0
  time = 0
  spyOn(performance, "now").mockImplementation(() => time)
  globalThis.requestAnimationFrame = (fn: FrameRequestCallback) => {
    frames.set(++id, fn)

    return id
  }

  globalThis.cancelAnimationFrame = (key: number) => {
    frames.delete(key)
  }
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  globalThis.requestAnimationFrame = originals.raf
  globalThis.cancelAnimationFrame = originals.caf
})

function frame() {
  time += 1000 / 60
  const next = [...frames.values()]
  frames.clear()

  for (const callback of next) callback(time)
}

function settle() {
  for (let i = 0; i < 120 && frames.size; i++) frame()
}

// How far out the layer is, in percent of its width; 0 at rest in place.
function away(element: HTMLElement) {
  return Number(/translateX\(calc\((-?[\d.e-]+)%/.exec(element.style.transform)?.[1] ?? 0)
}

function setup(initial: boolean) {
  const layer = document.createElement("div")
  document.body.append(layer)
  const [open, setOpen] = createSignal(initial)
  const [identity, setIdentity] = createSignal("a")
  const closed: number[] = []

  const motion = createRoot((dispose) => {
    cleanups.push(dispose, () => layer.remove())

    return createPanelMotion({
      open,
      layer: () => layer,
      edge: "end",
      spring: () => ({ duration: 0.2, bounce: 0 }),
      identity,
      onClosed: () => closed.push(time),
    })
  })

  return { layer, setOpen, setIdentity, closed, present: motion.present }
}

it("slides a pointer toggle in from its edge and out again, present until the close settles", () => {
  window.dispatchEvent(new Event("pointerdown"))
  const panel = setup(false)
  expect(panel.present()).toBe(false)

  panel.setOpen(true)
  expect(panel.present()).toBe(true)
  expect(away(panel.layer)).toBe(100)
  frame()
  expect(away(panel.layer)).toBeGreaterThan(0)
  expect(away(panel.layer)).toBeLessThan(100)
  settle()
  expect(panel.layer.style.transform).toBe("")

  panel.setOpen(false)
  frame()
  expect(panel.present()).toBe(true)
  expect(panel.closed).toEqual([])
  settle()
  expect(panel.present()).toBe(false)
  expect(panel.closed).toHaveLength(1)
})

it("turns around mid-flight from where it is", () => {
  window.dispatchEvent(new Event("pointerdown"))
  const panel = setup(false)
  panel.setOpen(true)
  frame()
  frame()
  frame()
  const before = away(panel.layer)

  panel.setOpen(false)
  expect(away(panel.layer)).toBe(before)
  frame()
  // Still carrying its inward velocity, it does not jump back out.
  expect(Math.abs(away(panel.layer) - before)).toBeLessThan(15)
  settle()
  expect(panel.present()).toBe(false)
})

it("applies keyboard toggles at once", () => {
  window.dispatchEvent(new Event("keydown"))
  const panel = setup(true)

  panel.setOpen(false)
  expect(panel.present()).toBe(false)
  expect(panel.closed).toHaveLength(1)
  expect(frames.size).toBe(0)
})

it("shows another layout's state without motion or a close", () => {
  window.dispatchEvent(new Event("pointerdown"))
  const panel = setup(true)

  panel.setIdentity("b")
  panel.setOpen(false)
  expect(frames.size).toBeGreaterThan(0)
  settle()

  panel.setOpen(true)
  settle()
  panel.setOpen(false)
  panel.setIdentity("c")
  expect(panel.present()).toBe(false)
  expect(panel.layer.style.transform).not.toBe("")
  expect(frames.size).toBe(0)
})
