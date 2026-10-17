export * as SessionAffinity from "./affinity.js"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import { SessionSchema } from "./schema.js"
import { SessionTable } from "./sql.js"

/** The Session ID that groups model requests for provider cache routing: children share the parent's, forks the fork source's. */
export const get = (session: Pick<SessionSchema.Info, "id" | "parentID" | "fork">) =>
  session.parentID ?? session.fork?.sessionID ?? session.id

/**
 * The Session ID whose cached prefix a request belongs to.
 *
 * A fork's messages are its source's messages up to a boundary, so a fork of a fork presents the
 * same prompt prefix as the root. Grouping it under the intermediate session sent a cache key
 * nothing had ever been written under, and its first request re-billed a prefix the root had
 * already cached.
 *
 * A child shares its parent's key and a plain session its own; neither has a lineage to walk, so
 * only forks read the database. A fork's lineage never changes, so each answer is resolved once.
 */
export const make = (db: Database.Interface["db"]) => {
  const resolved = new Map<SessionSchema.ID, SessionSchema.ID>()

  const root = (session: Pick<SessionSchema.Info, "id" | "parentID" | "fork">) =>
    Effect.gen(function* () {
      const start = get(session)
      if (session.parentID || !session.fork) return start

      const hit = resolved.get(start)
      if (hit) return hit

      let current = start
      const seen = new Set<SessionSchema.ID>([session.id, current])

      while (true) {
        const row = yield* db
          .select({ fork: SessionTable.fork_session_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, current))
          .get()
          .pipe(Effect.orDie)

        // A source that no longer exists, or one that is not itself a fork, ends the lineage. The
        // key the provider already saw stays the best answer available.
        if (!row?.fork || seen.has(row.fork)) break

        current = SessionSchema.ID.make(row.fork)
        seen.add(current)
      }

      resolved.set(start, current)
      return current
    })

  return { root }
}
