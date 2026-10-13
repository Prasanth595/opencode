import type { Definition } from "@opencode/gui-extensions/sdk/main"
import { extensionEnabled } from "@opencode/gui-extensions/sdk/bridge"
import type { Database } from "../storage/database"
import { extension } from "../storage/schema"
import { readEnableState } from "./enable-state"

/** Extension enable state in the desktop database, for built-ins and plugin GUI extensions alike. */
export function createManager(db: Database, definitions: readonly Definition[]) {
  return {
    /** The current id wins, then declared legacy ids newest first; no setting means enabled. */
    enabled(id: string) {
      return extensionEnabled(
        definitions.find((definition) => definition.id === id) ?? { id },
        readEnableState(db.$client),
      )
    },
    setEnabled(id: string, enabled: boolean) {
      db.insert(extension).values({ id, enabled }).onConflictDoUpdate({ target: extension.id, set: { enabled } }).run()
    },
  }
}
