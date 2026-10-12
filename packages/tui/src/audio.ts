import { Audio, type AudioErrorContext, type AudioPlayOptions, type AudioSound } from "@opentui/core"
import { readFile } from "node:fs/promises"

let audio: Audio | null | undefined
const sounds = new Map<string, Promise<AudioSound | null>>()

// Stop the engine this long after the last play once no voices are active.
// Stopping closes the native playback device, and play() restarts it on
// demand, so the device is only open around actual playback. A device left
// open while idle can wedge (e.g. an ALSA timer fd stuck readable across
// suspend/resume) and spin the engine's poll loop at 100% CPU indefinitely.
const IDLE_STOP_MS = 1000
let idleTimer: ReturnType<typeof setTimeout> | undefined

function clearIdleTimer() {
  if (idleTimer === undefined) return
  clearTimeout(idleTimer)
  idleTimer = undefined
}

function scheduleIdleStop() {
  clearIdleTimer()
  idleTimer = setTimeout(stopWhenIdle, IDLE_STOP_MS).unref()
}

function stopWhenIdle() {
  idleTimer = undefined
  const current = audio
  if (!current?.isStarted()) return
  if (voicesActive(current) > 0) {
    scheduleIdleStop()
    return
  }
  if (!stopSafely(current)) dispose()
}

function voicesActive(engine: Audio) {
  try {
    return engine.getStats()?.voicesActive ?? 0
  } catch (error) {
    console.debug("failed to read tui audio stats", { error })
    return 0
  }
}

function stopSafely(engine: Audio) {
  try {
    return engine.stop()
  } catch (error) {
    console.debug("failed to stop idle tui audio", { error })
    return false
  }
}

function getAudio() {
  if (audio !== undefined) return audio
  try {
    const next = Audio.create({ autoStart: false })
    next.on("error", (error: Error, context: AudioErrorContext) => {
      console.debug("tui audio error", { error, context })
    })
    audio = next
    return next
  } catch (error) {
    console.debug("failed to create tui audio", { error })
    audio = null
    return null
  }
}

export function loadSoundFile(file: string) {
  const current = getAudio()
  if (!current) return Promise.resolve(null)
  const cached = sounds.get(file)
  if (cached) return cached
  const task = readFile(file)
    .then((bytes) => current.loadSound(bytes))
    .catch((error) => {
      console.debug("failed to load tui sound", { file, error })
      return null
    })
  sounds.set(file, task)
  return task
}

export function play(sound: AudioSound, options?: AudioPlayOptions) {
  const current = getAudio()
  if (!current) return null
  if (!current.isStarted() && !current.start()) return null
  const voice = current.play(sound, options)
  if (voice !== null) scheduleIdleStop()
  return voice
}

export function dispose() {
  clearIdleTimer()
  audio?.dispose()
  audio = undefined
  sounds.clear()
}
