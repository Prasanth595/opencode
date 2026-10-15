import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client/promise"
import { bucketByDay, dayKey, startOfDay, sumCost } from "./model"

function session(created: number, cost: number, overrides: Partial<SessionInfo> = {}): SessionInfo {
  // SAFETY: test fixture only; cost/time/fields under test are fully populated, the rest is never read.
  return {
    id: `ses_${created}`,
    projectID: "proj_test",
    cost,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, updated: created },
    location: { directory: "/tmp" },
    ...overrides,
  } as SessionInfo
}

describe("spend aggregation", () => {
  test("buckets sessions by local day with correct dollar totals", () => {
    const now = new Date(2026, 9, 15, 14, 30).getTime()
    const today = startOfDay(now)
    const yesterday = today - 24 * 60 * 60 * 1000

    const sessions = [
      session(today + 3_600_000, 0.42),
      session(today + 7_200_000, 1.08),
      session(yesterday + 3_600_000, 2.5),
      session(yesterday - 20 * 24 * 60 * 60 * 1000, 99.99),
    ]

    const buckets = bucketByDay(sessions, 14, now)

    expect(buckets).toHaveLength(14)
    expect(buckets[13]?.key).toBe(dayKey(now))
    expect(buckets[13]?.total).toBeCloseTo(1.5, 10)
    expect(buckets[13]?.count).toBe(2)
    expect(buckets[12]?.total).toBeCloseTo(2.5, 10)
    expect(buckets[12]?.count).toBe(1)
    expect(buckets[0]?.total).toBe(0)
  })

  test("sums cost across sessions", () => {
    const now = Date.now()
    const sessions = [session(now, 0.1), session(now, 0.2), session(now, 0.3)]

    expect(sumCost(sessions)).toBeCloseTo(0.6, 10)
    expect(sumCost([])).toBe(0)
  })

  test("dayKey is stable for the same local day", () => {
    const morning = new Date(2026, 0, 5, 8, 0).getTime()
    const evening = new Date(2026, 0, 5, 22, 0).getTime()

    expect(dayKey(morning)).toBe(dayKey(evening))
    expect(dayKey(morning)).toBe("2026-01-05")
  })
})
