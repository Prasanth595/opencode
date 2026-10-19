import type { SpringValue } from "knobs"
import { motionTuning, type MotionKnob } from "./motion-tuning"

const global = "Global"

// Kit's palette, applied to every spring at once.
const palette = { snappy: 0.25, calm: 0.3, smooth: 0.45 }

/**
 * Mounts the Motion workspace into `container`: a tab per surface, Global on every tab, an action row per replay
 * button, presets and copy as code. knobs loads on first mount, so importing this module costs nothing until then.
 * Works anywhere a surface registered its knobs, including Storybook stories. Returns its removal.
 */
export function mountMotionPanel(container: HTMLElement, options: { title?: string } = {}) {
  let unmount: (() => void) | undefined
  let disposed = false

  void start()

  return () => {
    disposed = true
    unmount?.()
  }

  async function start() {
    const { action, defineControls, knob, spring, toggle } = await import("knobs")

    const field = (item: MotionKnob) => {
      const meta = { label: item.label, group: item.group, tab: item.group === global ? undefined : item.group }

      if (item.kind === "spring") return spring(item.initial, meta)

      if (item.kind === "toggle") return toggle(item.initial, meta)

      return knob(item.initial, { ...meta, min: item.min, max: item.max, step: item.step, unit: "×" })
    }

    const apply = (item: MotionKnob, value: SpringValue | boolean | number) => {
      if (item.kind === "spring") {
        // SAFETY: a spring knob's field is a spring field.
        return motionTuning.set(item, value as SpringValue)
      }

      if (item.kind === "toggle") {
        // SAFETY: a toggle knob's field is a toggle field.
        return motionTuning.set(item, value as boolean)
      }

      // SAFETY: a number knob's field is a number field.
      motionTuning.set(item, value as number)
    }

    const identity = () =>
      [...motionTuning.list(), ...motionTuning.actions()].map((item) => `${item.group}/${item.id}`).join()

    // Rebuilt when a surface registers or removes a knob or action.
    const mount = () => {
      unmount?.()
      const list = motionTuning.list()
      const actions = motionTuning.actions()
      const mounted = identity()
      const springs = list.flatMap((item) => (item.kind === "spring" ? [item] : []))

      const controls = defineControls(
        "opencode-motion",
        {
          ...Object.fromEntries(list.map((item) => [item.id, field(item)])),
          ...Object.fromEntries(
            actions.map((item) => [
              `action.${item.id}`,
              action(item.label, { group: item.group, tab: item.group, run: item.run }),
            ]),
          ),
        },
        {
          ship: () => import("knobs/panel"),
          persist: "variants",
          presets: Object.fromEntries(
            Object.entries(palette).map(([name, duration]) => [
              name,
              Object.fromEntries(springs.map((item) => [item.id, { duration, bounce: 0 }])),
            ]),
          ),
          onChange: (patch) =>
            list.forEach((item) => {
              const value = patch[item.id]

              if (value !== undefined) apply(item, value)
            }),
        },
      )

      const sync = () => controls.sync(Object.fromEntries(list.map((item) => [item.id, item.value])))
      sync()

      const stopPanel = controls.mount(container, {
        theme: "auto",
        title: options.title ?? "Motion",
        tabs: [...new Set([...list, ...actions].map((item) => item.group))].filter((group) => group !== global),
      })

      const stopWatch = motionTuning.subscribe(() => {
        // Edits from elsewhere, such as the debug bar's SLOW, show here too.
        if (identity() === mounted) return sync()
        mount()
      })

      unmount = () => {
        stopWatch()
        stopPanel()
      }
    }

    if (!disposed) mount()
  }
}
