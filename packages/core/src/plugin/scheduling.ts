export * as PluginScheduling from "./scheduling.js"

import { Effect, Semaphore } from "effect"

// Setup runs in registration order, but an entire generation must not occupy one
// JavaScript turn. The live Clock's zero-duration sleep yields through Effect's
// native scheduler (not a resolved promise), so HTTP, streaming and other
// locations progress below the operation-count auto-yield threshold. Serialize
// admission across locations so a scheduler batch cannot resume every cold
// location at once. Release BEFORE setup: asynchronous plugin work stays
// concurrent and can request another location without a process-wide deadlock.
// Keep the Clock injectable: virtual-clock tests must not wait for wall time.
const turn = Semaphore.makeUnsafe(1)
export const checkpoint = turn.withPermit(Effect.sleep(0)).pipe(Effect.withSpan("Plugin.init.eventLoopCheckpoint"))
