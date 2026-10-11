import { afterEach, describe, expect, test } from "bun:test"
import type { Audio } from "@opentui/core"
import { createAudioIdleRelease } from "../src/audio-idle"

const releases: ReturnType<typeof createAudioIdleRelease>[] = []

afterEach(() => {
  for (const release of releases) release.dispose()
  releases.length = 0
})

async function until(check: () => boolean) {
  const deadline = performance.now() + 2000
  while (!check() && performance.now() < deadline) await Bun.sleep(10)
  expect(check()).toBe(true)
}

function setup() {
  const state = { voices: 1, stops: 0, reads: 0, available: true, canStop: true }
  const audio: Pick<Audio, "getStats" | "stop"> = {
    getStats() {
      state.reads++
      if (!state.available) return null
      return {
        soundsLoaded: 1,
        voicesActive: state.voices,
        framesMixed: 0n,
        lockMisses: 0,
        lastPeak: 0,
        lastRms: 0,
      }
    },
    stop() {
      state.stops++
      return state.canStop
    },
  }
  const release = createAudioIdleRelease(audio)
  releases.push(release)
  return { state, release }
}

describe("audio idle release", () => {
  test("waits for every voice to finish, then stops polling", async () => {
    const { state, release } = setup()
    state.voices = 2
    release.watch()
    await Bun.sleep(150)
    expect(state.stops).toBe(0)
    state.voices = 1
    await Bun.sleep(150)
    expect(state.stops).toBe(0)
    state.voices = 0
    await until(() => state.stops === 1)
    const reads = state.reads
    await Bun.sleep(150)
    expect(state.reads).toBe(reads)
  })

  test("can watch playback again after releasing the device", async () => {
    const { state, release } = setup()
    state.voices = 0
    release.watch()
    await until(() => state.stops === 1)
    state.voices = 1
    release.watch()
    await Bun.sleep(150)
    expect(state.stops).toBe(1)
    state.voices = 0
    await until(() => state.stops === 2)
  })

  test("releases a started device when no voice was created", async () => {
    const { state, release } = setup()
    state.voices = 0
    release.watch()
    release.watch()
    await until(() => state.stops === 1)
    await Bun.sleep(150)
    expect(state.stops).toBe(1)
  })

  test("does not assume missing statistics mean idle", async () => {
    const { state, release } = setup()
    state.available = false
    state.voices = 0
    release.watch()
    await Bun.sleep(150)
    expect(state.stops).toBe(0)
    state.available = true
    await until(() => state.stops === 1)
  })

  test("retries a failed stop", async () => {
    const { state, release } = setup()
    state.voices = 0
    state.canStop = false
    release.watch()
    await until(() => state.stops > 0)
    state.canStop = true
    const stops = state.stops
    await until(() => state.stops > stops)
    const reads = state.reads
    await Bun.sleep(150)
    expect(state.reads).toBe(reads)
  })

  test("disposal cancels polling", async () => {
    const { state, release } = setup()
    release.watch()
    release.dispose()
    await Bun.sleep(150)
    expect(state.reads).toBe(0)
    expect(state.stops).toBe(0)
  })
})
