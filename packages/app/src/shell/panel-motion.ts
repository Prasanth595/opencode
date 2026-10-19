import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { frameLoop, prefersReducedMotion, Spring, type DurationOptions } from "@opencode/ui/motion"
import { motionTuning } from "@opencode/ui/motion-tuning"

const sidebar = motionTuning.spring("sidebar", { label: "Spring", group: "Left sidebar", duration: 0.2, bounce: 0 })

const side = motionTuning.spring("sidePanel", { label: "Spring", group: "Side panel", duration: 0.2, bounce: 0 })

const linked = motionTuning.toggle("sidePanelLinked", {
  label: "Follow the left sidebar's spring",
  group: "Side panel",
  value: true,
})

const keyboardInstant = motionTuning.toggle("keyboardInstant", {
  label: "Keyboard toggles are instant",
  group: "Global",
  value: true,
})

export const panelSprings = {
  sidebar,
  side: () => (linked() ? sidebar() : side()),
}

/** Adds buttons that play a panel's toggle to its Motion workspace section while the panel is mounted. */
export function replayPanelToggle(input: {
  id: string
  group: string
  toggle: () => void
  spring: () => DurationOptions
}) {
  onCleanup(
    motionTuning.action({ id: `${input.id}.toggle`, label: "Open / close", group: input.group, run: input.toggle }),
  )

  onCleanup(
    motionTuning.action({
      id: `${input.id}.reverse`,
      label: "Toggle, reverse mid-flight",
      group: input.group,
      run: () => {
        input.toggle()
        setTimeout(input.toggle, input.spring().duration * 350)
      },
    }),
  )
}

// Whether the input that caused a toggle was a key press, so shortcuts can skip the motion.
let keyboard = false

if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (keyboard = true), true)
  window.addEventListener("pointerdown", () => (keyboard = false), true)
}

/**
 * Opens and closes an edge panel without animating layout. Layout commits once, when the toggle happens; then the
 * panel's layer slides on a spring between its place and just past its edge, over the content on the way out.
 * `present` stays true until a close settles.
 */
export function createPanelMotion(input: {
  open: Accessor<boolean>
  layer: Accessor<HTMLElement | undefined>
  edge: "start" | "end"
  spring: () => DurationOptions
  /** Extra distance past the layer's own width, in pixels. */
  overshoot?: number
  /** A change shows the new state without motion, e.g. switching to another session's layout. */
  identity?: Accessor<unknown>
  onClosed?: () => void
}) {
  const [present, setPresent] = createSignal(input.open())
  // Percent of the travel still to go: 0 rests in place, 100 rests fully out.
  const spring = new Spring(input.open() ? 0 : 100)
  let sign = 1
  let stop: (() => void) | undefined

  const paint = () => {
    const element = input.layer()

    if (!element) return
    const away = spring.value * sign
    element.style.transform =
      away === 0 ? "" : `translateX(calc(${away}% + ${(away / 100) * (input.overshoot ?? 0)}px))`
  }

  const settle = () => {
    stop?.()
    stop = undefined

    if (input.open()) return
    setPresent(false)
    input.onClosed?.()
  }

  createEffect(
    on(
      () => [input.open(), input.identity?.()] as const,
      ([open, identity], previous) => {
        const target = open ? 0 : 100

        if (open) setPresent(true)

        if (previous === undefined || previous[1] !== identity) {
          stop?.()
          stop = undefined
          spring.snap(target)
          paint()

          if (!open) setPresent(false)

          return
        }

        if (prefersReducedMotion() || (keyboard && keyboardInstant())) {
          spring.snap(target)
          paint()
          settle()

          return
        }

        const rtl = getComputedStyle(input.layer() ?? document.documentElement).direction === "rtl"
        sign = (input.edge === "start") !== rtl ? -1 : 1
        paint()
        const tuning = input.spring()
        spring.omega = (2 * Math.PI) / tuning.duration
        spring.zeta = 1 - tuning.bounce
        spring.set(target)
        stop ??= frameLoop.add((dt) => {
          spring.step(dt)
          paint()

          if (!spring.resting) return true
          stop = undefined
          settle()

          return false
        })
      },
    ),
  )

  // A layer that mounts mid-flight, such as the side panel after a close unmounted it, starts where the spring is.
  createEffect(on(input.layer, paint))

  onCleanup(() => stop?.())

  return { present }
}
