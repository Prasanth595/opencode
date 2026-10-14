import { extensionEnabled } from "@opencode/plugin/gui/host"
import type { Database } from "../storage/database"
import { extension } from "../storage/schema"
import { readEnableState } from "./enable-state"

/** Extension enable state in the desktop database, for built-ins and plugin GUI extensions alike. */
export function createManager(db: Database) {
  return {
    /** The setting saved under the id; no setting means enabled. */
    enabled(id: string) {
      return extensionEnabled(id, readEnableState(db.$client))
    },
    setEnabled(id: string, enabled: boolean) {
      db.insert(extension).values({ id, enabled }).onConflictDoUpdate({ target: extension.id, set: { enabled } }).run()
    },
  }
}
