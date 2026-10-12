import type { ModelInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"
import { Locale } from "./locale"

type SessionNode = {
  id: string
  parentID?: string | null
}

export function sessionFamily<T extends SessionNode>(sessions: readonly T[], sessionID: string) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const current = byID.get(sessionID)
  if (!current) return []

  const children = new Map<string, T[]>()
  sessions.forEach((session) => {
    if (!session.parentID) return
    const group = children.get(session.parentID)
    if (group) group.push(session)
    else children.set(session.parentID, [session])
  })

  function root(session: T): T {
    const parent = session.parentID ? byID.get(session.parentID) : undefined
    return parent ? root(parent) : session
  }

  function walk(parentID: string, ancestors: boolean[]): Array<{ session: T; prefix: string }> {
    const group = children.get(parentID) ?? []
    return group.flatMap((session, index) => {
      const last = index === group.length - 1
      const prefix =
        ancestors.length === 0
          ? ""
          : ancestors
              .slice(1)
              .map((ancestor) => (ancestor ? "   " : "│  "))
              .join("") + (last ? "└─ " : "├─ ")
      return [{ session, prefix }, ...walk(session.id, [...ancestors, last])]
    })
  }

  return walk(root(current).id, [])
}

export function lastAssistantWithUsage(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string) {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )
  return messages.findLast(
    (message, index): message is SessionMessageAssistant & { tokens: NonNullable<SessionMessageAssistant["tokens"]> } =>
      message.type === "assistant" && message.tokens !== undefined && index > compactionIndex && index < end,
  )
}

export function contextUsage(
  messages: ReadonlyArray<SessionMessageInfo>,
  models: ReadonlyArray<ModelInfo> | undefined,
  boundary?: string,
) {
  const last = lastAssistantWithUsage(messages, boundary)
  if (!last) return
  const tokens =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  if (tokens <= 0) return
  const model = models?.find((model) => model.providerID === last.model.providerID && model.id === last.model.id)
  const budget = model?.context?.[last.model.variant?.endsWith("@long") ? "long" : "default"]
  const input = budget === undefined ? undefined : Math.min(budget, model?.limit.input ?? budget)
  const limit =
    model && input !== undefined ? Math.min(model.limit.context, input + model.limit.output) : model?.limit.context
  return {
    tokens,
    percent: limit ? Math.round((tokens / limit) * 100) : undefined,
  }
}

export function formatSessionCost(cost: number, messages: readonly SessionMessageInfo[]) {
  const usage = messages.filter((message) => message.type === "assistant" || ("cost" in message && !!message.cost))
  const total = messages.reduce((sum, message) => sum + ("cost" in message ? (message.cost ?? 0) : 0), 0)
  const complete = Math.abs(total - cost) <= 1e-8 * Math.max(total, cost, Number.EPSILON)
  if (
    complete &&
    usage.length > 0 &&
    usage.every((message) => "model" in message && message.model?.providerID === "github-copilot")
  )
    return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cost * 100)} AI credits`
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cost)
}

export function formatContextUsage(tokens: number, percent?: number) {
  const value = Locale.number(tokens)
  return percent === undefined ? value : `${value} (${percent}%)`
}
