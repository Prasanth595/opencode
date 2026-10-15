import { skipToken, useQuery } from "@tanstack/solid-query"
import { For, Match, Show, Switch, createMemo } from "solid-js"
import type { SessionInfo } from "@opencode/client/promise"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useServerCtx, type ServerCtx } from "@/runtime/server/runtime"
import {
  bucketByDay,
  formatDayLabel,
  formatMoney,
  formatTime,
  isToday,
  isYesterday,
  startOfDay,
} from "./model"

const PAGE_LIMIT = 200

const MAX_PAGES = 10

const LOOKBACK_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000

const RECENT_LIMIT = 20

async function fetchSpendSessions(ctx: ServerCtx, signal: AbortSignal): Promise<Array<SessionInfo>> {
  const sessions: Array<SessionInfo> = []

  const cutoff = startOfDay(Date.now()) - (LOOKBACK_DAYS - 1) * DAY_MS

  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await ctx.sdk.api.session.list(
      { parentID: null, limit: PAGE_LIMIT, order: "desc", cursor },
      { signal },
    )

    sessions.push(...response.data)

    const oldest = response.data[response.data.length - 1]

    const next = response.cursor.next ?? undefined

    if (!next || !oldest || oldest.time.created < cutoff) break

    cursor = next
  }

  return sessions
}

export function SpendView() {
  const language = useLanguage()

  const servers = useServers()

  const server = createMemo(() => servers.visible[0])

  const ctx = useServerCtx(server)

  const sessionsQuery = useQuery(() => {
    const connection = server()

    const context = ctx()

    return {
      queryKey: ["spend-sessions", connection ? ServerConnection.key(connection) : "none"] as const,
      enabled: !!context && context.sdk.connection.status() === "connected",
      queryFn: context ? ({ signal }: { signal: AbortSignal }) => fetchSpendSessions(context, signal) : skipToken,
      retry: false,
      staleTime: 30_000,
      refetchOnMount: true,
    }
  })

  const sessions = createMemo(() => sessionsQuery.data ?? [])

  const buckets = createMemo(() => bucketByDay(sessions(), LOOKBACK_DAYS))

  const todayTotal = createMemo(() => buckets()[LOOKBACK_DAYS - 1]?.total ?? 0)

  const weekTotal = createMemo(() => buckets().slice(-7).reduce((total, bucket) => total + bucket.total, 0))

  const hasUsage = createMemo(() => sessions().length > 0)

  const maxBucket = createMemo(() => buckets().reduce((max, bucket) => Math.max(max, bucket.total), 0))

  const connected = createMemo(() => {
    const context = ctx()

    return !!context && context.sdk.connection.status() === "connected"
  })

  const sessionWhen = (created: number): string => {
    const time = formatTime(created)

    if (isToday(created)) return language.t("spend.session.time.today", { time })

    if (isYesterday(created)) return language.t("spend.session.time.yesterday", { time })

    return language.t("spend.session.time.date", { date: formatDayLabel(created), time })
  }

  const dayLabel = (start: number): string => {
    if (isToday(start)) return language.t("spend.day.today")

    if (isYesterday(start)) return language.t("spend.day.yesterday")

    return formatDayLabel(start)
  }

  return (
    <div
      data-slot="spend-panel"
      class="mx-[var(--shell-inline-inset,8px)] mb-[var(--shell-bottom-inset,8px)] mt-[var(--shell-top-inset,8px)] flex min-h-0 flex-1 flex-col self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
    >
      <div class="mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col gap-6 overflow-y-auto px-6 py-8">
        <h1 class="text-xl font-semibold">{language.t("spend.title")}</h1>

        <Show when={!connected()}>
          <p class="text-sm opacity-70">{language.t("spend.noServer")}</p>
        </Show>

        <Show when={connected()}>
          <Switch>
            <Match when={sessionsQuery.isPending}>
              <p class="text-sm opacity-70">{language.t("spend.loading")}</p>
            </Match>
            <Match when={sessionsQuery.isError}>
              <div class="flex flex-col items-start gap-3">
                <p class="text-sm opacity-70">{language.t("spend.error")}</p>

                <button
                  type="button"
                  class="cursor-pointer rounded-md bg-v2-background-bg-accent px-4 py-2 text-sm font-medium"
                  onClick={() => sessionsQuery.refetch()}
                >
                  {language.t("spend.retry")}
                </button>
              </div>
            </Match>
            <Match when={sessionsQuery.isSuccess}>
              <Show
                when={hasUsage()}
                fallback={
                  <div class="flex flex-col gap-2">
                    <p class="text-base font-medium">{language.t("spend.empty.title")}</p>

                    <p class="text-sm opacity-70">{language.t("spend.empty.body")}</p>
                  </div>
                }
              >
                <div class="grid grid-cols-2 gap-4">
                  <div class="rounded-[10px] bg-v2-background-bg-subtle p-4">
                    <p class="text-sm opacity-70">{language.t("spend.today")}</p>

                    <p class="text-2xl font-semibold">{formatMoney(todayTotal())}</p>
                  </div>

                  <div class="rounded-[10px] bg-v2-background-bg-subtle p-4">
                    <p class="text-sm opacity-70">{language.t("spend.thisWeek")}</p>

                    <p class="text-2xl font-semibold">{formatMoney(weekTotal())}</p>
                  </div>
                </div>

                <div class="flex flex-col gap-3">
                  <h2 class="text-base font-medium">{language.t("spend.last14Days")}</h2>

                  <div class="flex flex-col gap-2">
                    <For each={buckets()}>
                      {(bucket) => (
                        <div class="flex items-center gap-3">
                          <span class="w-28 shrink-0 text-sm opacity-70">{dayLabel(bucket.start)}</span>

                          <div class="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-v2-background-bg-subtle">
                            <Show when={bucket.total > 0 && maxBucket() > 0}>
                              <div
                                class="h-full rounded-full bg-v2-background-bg-accent"
                                style={{ width: `${Math.max(4, (bucket.total / maxBucket()) * 100)}%` }}
                              />
                            </Show>
                          </div>

                          <span class="w-20 shrink-0 text-right text-sm tabular-nums">
                            {formatMoney(bucket.total)}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>

                <div class="flex flex-col gap-3">
                  <h2 class="text-base font-medium">{language.t("spend.recentActivity")}</h2>

                  <div class="flex flex-col divide-y divide-v2-border-border-subtle">
                    <For each={sessions().slice(0, RECENT_LIMIT)}>
                      {(session) => (
                        <div class="flex items-baseline justify-between gap-3 py-2">
                          <span class="min-w-0 flex-1 truncate text-sm">
                            {session.title ? (
                              <>
                                <span class="font-medium">{session.title}</span>

                                <span class="opacity-70"> · {sessionWhen(session.time.created)}</span>
                              </>
                            ) : (
                              sessionWhen(session.time.created)
                            )}
                          </span>

                          <span class="shrink-0 text-sm font-medium tabular-nums">
                            {formatMoney(session.cost)}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </Match>
          </Switch>
        </Show>
      </div>
    </div>
  )
}
