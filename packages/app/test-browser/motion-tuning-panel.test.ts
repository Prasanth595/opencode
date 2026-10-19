import { afterEach, expect, it } from "bun:test"
import { motionTuning } from "@opencode/ui/motion-tuning"
import { mountMotionPanel } from "@opencode/ui/motion-tuning-panel"

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
})

it("offers Snappy, Smooth and Calm for every spring, with one Global card and one card per section", async () => {
  const drawer = motionTuning.spring("test.drawer", {
    label: "Spring",
    group: "Drawer",
    presets: {
      snappy: { duration: 0.15, bounce: 0 },
      smooth: { duration: 0.25, bounce: 0 },
      calm: { duration: 0.4, bounce: 0 },
    },
  })

  const image = motionTuning.spring("test.image", {
    label: "Spring",
    group: "Image open",
    presets: {
      snappy: { duration: 0.2, bounce: 0 },
      smooth: { duration: 0.3, bounce: 0 },
      calm: { duration: 0.4, bounce: 0 },
    },
  })

  cleanups.push(motionTuning.action({ id: "test.replay", label: "Replay", group: "Drawer", run: () => {} }))

  const container = document.createElement("div")
  document.body.append(container)
  cleanups.push(mountMotionPanel(container, { section: "Drawer" }))

  const chip = await waitFor(() =>
    [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Smooth"),
  )

  const labels = [...container.querySelectorAll("button")].map((button) => button.textContent?.trim())

  expect(labels).toContain("Snappy")
  expect(labels).toContain("Calm")
  expect(labels).not.toContain("default")

  // Global once, then the section's spring with its replay buttons under a sub-heading in the same card.
  const shown = (selector: string) =>
    [...container.querySelectorAll(selector)].flatMap((element) =>
      element.closest("[hidden]") === null ? [element.textContent?.trim()] : [],
    )

  expect(shown(".knobs-group-label")).toEqual(["Global", "Drawer"])
  expect(shown(".knobs-subhead-label")).toEqual(["Replay"])
  expect(labels).not.toContain("Jump to…")
  expect(drawer()).toEqual({ duration: 0.15, bounce: 0 })

  chip.click()
  expect(drawer()).toEqual({ duration: 0.25, bounce: 0 })
  expect(image()).toEqual({ duration: 0.3, bounce: 0 })
})

async function waitFor<T>(find: () => T | undefined) {
  for (let i = 0; i < 200; i++) {
    const found = find()

    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error("timed out")
}
