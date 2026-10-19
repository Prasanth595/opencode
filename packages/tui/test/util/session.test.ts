import { describe, expect, test } from "bun:test"
import { sessionFamily, sessionTreeIDs } from "../../src/util/session"

describe("util.session", () => {
  test("flattens nested subagents from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild-a", parentID: "child-a" },
      { id: "great-grandchild-a", parentID: "grandchild-a" },
      { id: "grandchild-a2", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "grandchild-b", parentID: "child-b" },
    ]

    expect(sessionTreeIDs(sessions, "child-a")).toEqual([
      "child-a",
      "grandchild-a",
      "grandchild-a2",
      "great-grandchild-a",
    ])
    expect(sessionTreeIDs(sessions, "root")).toEqual([
      "root",
      "child-a",
      "child-b",
      "grandchild-a",
      "grandchild-a2",
      "grandchild-b",
      "great-grandchild-a",
    ])
    expect(sessionTreeIDs([], "child-a")).toEqual(["child-a"])

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })
})
