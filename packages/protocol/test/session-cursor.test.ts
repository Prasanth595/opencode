import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionsCursor, SessionsQuery } from "../src/groups/session.js"
import { Session } from "@opencode/schema/session"

const anchor = { id: Session.ID.make("ses_test"), time: 1, direction: "next" as const }

describe("SessionsCursor", () => {
  test("round trips without Node globals", async () => {
    const input = { search: "protocol", order: "desc" as const, anchor }
    const cursor = SessionsCursor.make(input)

    expect(await Effect.runPromise(SessionsCursor.parse(cursor))).toEqual(input)
  })

  test("keeps every filter of a valid query", async () => {
    const queries = [
      { directory: "/repo", parentID: "null", order: "asc" },
      { project: "prj_test", subpath: "packages/core", search: "x" },
      { project: "prj_test" },
    ]
    const decoded = queries.map((query) => Schema.decodeUnknownSync(SessionsQuery)(query))

    const parsed = await Effect.runPromise(
      Effect.forEach(decoded, (query) => SessionsCursor.parse(SessionsCursor.make({ ...query, anchor }))),
    )
    expect(parsed).toEqual(decoded.map((query) => ({ ...query, anchor })))
  })
})
