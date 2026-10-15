import { createMemo } from "solid-js"
import { Schema } from "effect"
import { useProviders } from "@/providers/catalog/providers"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"

const FLAG_KEY = "ember.first-run.v1"

/**
 * True when this looks like a first launch: no AI provider is connected and
 * the wizard was never completed or skipped. `anyConnection()` is undefined
 * while the catalogs load, so loading is never mistaken for a first run.
 */
export function useFirstRunDetection() {
  const providers = useProviders(() => undefined)

  const [flag, setFlag] = persisted(
    Persist.global(FLAG_KEY),
    Persistence.struct({ done: Schema.Boolean }),
    { done: false },
  )

  const show = createMemo(() => !flag.done && providers.anyConnection() === false)
  const dismiss = () => setFlag("done", true)

  return { show, dismiss }
}
