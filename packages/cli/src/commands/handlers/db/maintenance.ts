import { Database } from "bun:sqlite"

/** Compact an offline database and enable incremental page reclamation. */
export function compactDatabase(filename: string) {
  const database = new Database(filename)
  try {
    const pageSize = Number(database.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0)
    const pageCount = () => Number(database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0)
    const beforeBytes = pageCount() * pageSize
    database.exec("PRAGMA busy_timeout = 0; PRAGMA auto_vacuum = INCREMENTAL; VACUUM; PRAGMA incremental_vacuum(256)")
    return { beforeBytes, afterBytes: pageCount() * pageSize }
  } catch (cause) {
    const message =
      typeof cause === "object" && cause !== null && "message" in cause ? String(cause.message) : String(cause)
    if (/SQLITE_(?:BUSY|LOCKED)|database (?:table )?is locked/i.test(message))
      throw new Error("Database is in use by another process; stop every OpenCode process before vacuuming.", { cause })
    throw cause
  } finally {
    database.close()
  }
}
