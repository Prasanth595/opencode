import { expect, test } from "bun:test"
import { extensionEnabled } from "@opencode/plugin/gui/host"
import { openDatabase } from "../storage/database"
import { extension } from "../storage/schema"
import { readEnableState } from "./enable-state"
import { createManager } from "./manager"

test.each([
  { name: "no setting", rows: [], expected: true },
  { name: "a disabled setting", rows: [{ id: "current", enabled: false }], expected: false },
  { name: "an enabled setting", rows: [{ id: "current", enabled: true }], expected: true },
  { name: "another plugin's setting", rows: [{ id: "other", enabled: false }], expected: true },
])("both hosts resolve $name from real database rows, and a new setting wins", (input) => {
  const database = openDatabase(":memory:")
  const manager = createManager(database.db)
  input.rows.forEach((row) => database.db.insert(extension).values(row).run())

  expect(manager.enabled("current")).toBe(input.expected)
  expect(extensionEnabled("current", readEnableState(database.db.$client))).toBe(input.expected)

  const before = database.db.select().from(extension).all()

  manager.setEnabled("current", !input.expected)
  expect(manager.enabled("current")).toBe(!input.expected)
  expect(extensionEnabled("current", readEnableState(database.db.$client))).toBe(!input.expected)
  expect(
    database.db
      .select()
      .from(extension)
      .all()
      .filter((row) => row.id !== "current"),
  ).toEqual(before.filter((row) => row.id !== "current"))
  database.close()
})
