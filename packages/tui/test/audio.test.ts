import { beforeEach, describe, expect, mock, test } from "bun:test"
import { currentEngine, FakeAudio, resetFakes } from "./audio-fake"

mock.module("@opentui/core", () => ({ Audio: FakeAudio }))

const { dispose, play } = await import("../src/audio")

async function idleSettled() {
  await Bun.sleep(1300)
}

beforeEach(() => {
  dispose()
  resetFakes()
})

describe("tui audio idle stop", () => {
  test("stops the engine once voices drain", async () => {
    const voice = play(1)
    expect(voice).toBe(1)
    const engine = currentEngine()
    expect(engine.isStarted()).toBe(true)

    engine.voices = 0
    await idleSettled()

    expect(engine.stopCalls).toBe(1)
    expect(engine.isStarted()).toBe(false)
    expect(engine.disposed).toBe(false)
  })

  test("keeps the engine running while voices are active", async () => {
    play(1)
    const engine = currentEngine()

    await idleSettled()
    expect(engine.stopCalls).toBe(0)

    engine.voices = 0
    await idleSettled()
    expect(engine.stopCalls).toBe(1)
  })

  test("restarts a stopped engine on the next play", async () => {
    play(1)
    const engine = currentEngine()
    engine.voices = 0
    await idleSettled()
    expect(engine.isStarted()).toBe(false)

    play(1)
    expect(engine.isStarted()).toBe(true)
    expect(engine.stopCalls).toBe(1)
  })

  test("disposes an engine that refuses to stop", async () => {
    play(1)
    const engine = currentEngine()
    engine.voices = 0
    engine.stopResult = false
    await idleSettled()

    expect(engine.disposed).toBe(true)

    play(1)
    expect(currentEngine()).not.toBe(engine)
  })
})
