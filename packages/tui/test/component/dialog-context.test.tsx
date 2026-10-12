import { expect, test } from "bun:test"
import { CliRenderEvents, InputRenderable } from "@opentui/core"
import { once } from "node:events"
import { DialogContext } from "../../src/component/dialog-context"
import { agent, model, renderLocal } from "../fixture/local"

test("context picker preserves reasoning at narrow and wide terminal sizes", async () => {
  await using setup = await renderLocal({
    models: [
      {
        ...model("first", ["high"]),
        context: { default: 272_000, long: 922_000 },
      },
    ],
    agents: [agent("build", { providerID: "provider", id: "first", variant: "high" })],
  })
  for (const width of [60, 120]) {
    setup.renderer.resize(width, 24)
    setup.dialog.replace(() => <DialogContext />)
    await setup.waitForFrame((frame) => frame.includes("Select context window") && frame.includes("922,000"))
    if (!(setup.renderer.currentFocusedRenderable instanceof InputRenderable))
      await once(setup.renderer, CliRenderEvents.FOCUSED_RENDERABLE)
    await setup.mockInput.typeText("Long")
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.waitFor(() => setup.dialog.stack.length === 0)
    expect(setup.local.model.variant.raw()).toBe("high@long")
    expect(setup.local.model.variant.current()).toBe("high")
    setup.local.model.context.set("default")
  }
})

test("context picker displays configured input caps", async () => {
  await using setup = await renderLocal({
    models: [
      {
        ...model("first"),
        context: { default: 272_000, long: 922_000 },
        limit: { context: 1_050_000, input: 100_000, output: 128_000 },
      },
    ],
  })
  setup.dialog.replace(() => <DialogContext />)
  const frame = await setup.waitForFrame(
    (frame) => frame.includes("Select context window") && frame.includes("100,000"),
  )
  expect(frame).not.toContain("272,000")
  expect(frame).not.toContain("922,000")
})
