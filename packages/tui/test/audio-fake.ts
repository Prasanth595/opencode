// Test double for the native audio engine. Lives in its own module so the
// mock.module() factory in audio.test.ts can reference it: the factory runs
// while imports are still being evaluated, so anything it touches must
// already be initialized (a helper module imported first satisfies that).

export const engines: FakeAudio[] = []

export function resetFakes() {
  engines.length = 0
}

export class FakeAudio {
  started = false
  stopCalls = 0
  stopResult = true
  disposed = false
  voices = 0
  sounds = 0

  static create() {
    const engine = new FakeAudio()
    engines.push(engine)
    return engine
  }

  on() {
    return this
  }

  isStarted() {
    return this.started
  }

  start() {
    this.started = true
    return true
  }

  play() {
    this.voices += 1
    return this.voices
  }

  getStats() {
    return {
      soundsLoaded: this.sounds,
      voicesActive: this.voices,
      framesMixed: 0n,
      lockMisses: 0,
      lastPeak: 0,
      lastRms: 0,
    }
  }

  stop() {
    this.stopCalls += 1
    this.started = false
    return this.stopResult
  }

  loadSound() {
    this.sounds += 1
    return this.sounds
  }

  dispose() {
    this.disposed = true
  }
}

export const currentEngine = () => engines[engines.length - 1]
