import type { SessionInfo } from "@opencode/client/promise"

export interface DayBucket {
  key: string
  start: number
  total: number
  count: number
}

const DAY_MS = 24 * 60 * 60 * 1000

const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" })

export function formatMoney(amount: number): string {
  return usd.format(amount)
}

export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)

  date.setHours(0, 0, 0, 0)

  return date.getTime()
}

export function dayKey(timestamp: number): string {
  const date = new Date(timestamp)

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function isToday(timestamp: number, now = Date.now()): boolean {
  return dayKey(timestamp) === dayKey(now)
}

export function isYesterday(timestamp: number, now = Date.now()): boolean {
  return dayKey(timestamp) === dayKey(now - DAY_MS)
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { timeStyle: "short" })
}

export function formatDayLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
}

export function bucketByDay(
  sessions: ReadonlyArray<SessionInfo>,
  days: number,
  now = Date.now(),
): Array<DayBucket> {
  const todayStart = startOfDay(now)

  const buckets = Array.from({ length: days }, (_, index) => {
    const start = todayStart - (days - 1 - index) * DAY_MS

    return { key: dayKey(start), start, total: 0, count: 0 }
  })

  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]))

  for (const session of sessions) {
    const bucket = byKey.get(dayKey(session.time.created))

    if (bucket) {
      bucket.total += session.cost
      bucket.count += 1
    }
  }

  return buckets
}

export function sumCost(sessions: ReadonlyArray<SessionInfo>): number {
  return sessions.reduce((total, session) => total + session.cost, 0)
}
