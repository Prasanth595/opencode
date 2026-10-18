import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261018054117_project_icon_repository",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`project\` ADD \`repository\` text;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`icon_discovered\` text;`)
    })
  },
}

export default migration
