import type { Audio } from "@opentui/core"

export function createAudioIdleRelease(audio: Pick<Audio, "getStats" | "stop">) {
  let timer: ReturnType<typeof setInterval> | undefined

  function clear() {
    clearInterval(timer)
    timer = undefined
  }

  return {
    watch() {
      if (timer !== undefined) return
      timer = setInterval(() => {
        const stats = audio.getStats()
        if (!stats || stats.voicesActive !== 0) return
        if (audio.stop()) clear()
      }, 100)
      timer.unref()
    },
    dispose: clear,
  }
}
