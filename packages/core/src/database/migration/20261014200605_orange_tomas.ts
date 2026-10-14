import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261014200605_orange_tomas",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`temp\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
