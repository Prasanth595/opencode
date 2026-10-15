/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../../src/config"
import { PromptMetadataRow, type PromptMetadataTarget } from "../../src/component/prompt/metadata"
import { ThemeProvider } from "../../src/context/theme"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const HIGHLIGHT = RGBA.fromValues(88, 101, 242, 1)

function renderRow(onPick: (target: PromptMetadataTarget) => void) {
  return testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({})}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <box flexDirection="column">
              <PromptMetadataRow
                mode="normal"
                agent="Build"
                auto={false}
                model="Sonnet"
                provider="Anthropic"
                variant="high"
                muted={false}
                highlight={HIGHLIGHT}
                agentAlpha={1}
                modelAlpha={1}
                variantAlpha={1}
                onPick={onPick}
              />
              <text>selectable transcript text</text>
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 60, height: 4 },
  )
}

test("clicking the agent, model and variant labels picks the matching target", async () => {
  const picked: PromptMetadataTarget[] = []
  const app = await renderRow((target) => picked.push(target))
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Sonnet"))
    const row = app.captureCharFrame().split("\n")[0] ?? ""
    const column = (needle: string) => row.indexOf(needle)

    await app.mockMouse.click(column("Build"), 0)
    expect(picked).toEqual(["agent"])

    await app.mockMouse.click(column("Sonnet"), 0)
    expect(picked).toEqual(["agent", "model"])

    await app.mockMouse.click(column("Anthropic"), 0)
    expect(picked).toEqual(["agent", "model", "model"])

    await app.mockMouse.click(column("high"), 0)
    expect(picked).toEqual(["agent", "model", "model", "variant"])
  } finally {
    app.renderer.destroy()
  }
})

test("releasing a transcript selection over the labels does not pick a target", async () => {
  const picked: PromptMetadataTarget[] = []
  const app = await renderRow((target) => picked.push(target))
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Sonnet"))
    const row = app.captureCharFrame().split("\n")[0] ?? ""

    await app.mockMouse.pressDown(0, 1)
    await app.mockMouse.release(row.indexOf("Build"), 0)
    expect(picked).toEqual([])

    await app.mockMouse.click(row.indexOf("Build"), 0)
    expect(picked).toEqual(["agent"])
  } finally {
    app.renderer.destroy()
  }
})

test("pressing a label and releasing off it does not pick a target", async () => {
  const picked: PromptMetadataTarget[] = []
  const app = await renderRow((target) => picked.push(target))
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Sonnet"))
    const row = app.captureCharFrame().split("\n")[0] ?? ""

    await app.mockMouse.pressDown(row.indexOf("Build"), 0)
    await app.mockMouse.release(row.indexOf("Sonnet"), 0)
    expect(picked).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})
