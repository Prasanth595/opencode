import { beforeAll, expect, mock, setSystemTime, test, vi } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { ServerSDK } from "@/runtime/server/client"
import type { Data } from "@opencode/client/solid"
import type { ServerConnection } from "@/runtime/server/registry"
import { ServerScope } from "@/runtime/server/scope"
import type { Tab } from "@/shell/tabs/tabs"

const server = "local\nhttp://localhost:4096" as ServerConnection.Key

const session = { id: "session-1", title: "Test session", location: { directory: "/project" } }

const alerts: string[] = []

const tabs: { store: Tab[] } = { store: [] }

let createServerNotificationState: typeof import("@/shell/notifications/notification").createServerNotificationState

beforeAll(async () => {
  const { sessionIDHasOpenTab } = await import("@/shell/tabs/tabs")
  mock.module("@/runtime/platform/platform", () => ({
    usePlatform: () => ({
      platform: "web",
      notify: async (title: string) => {
        alerts.push(title)
      },
    }),
  }))
  mock.module("@/settings/model", () => ({
    useSettings: () => ({
      sounds: { agentEnabled: () => false, errorsEnabled: () => false },
      notifications: { agent: () => true, errors: () => true },
    }),
  }))
  mock.module("@/runtime/i18n/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
  mock.module("@/shell/tabs/tabs", () => ({
    useTabs: () => tabs,
    sessionIDHasOpenTab,
  }))
  createServerNotificationState = (await import("@/shell/notifications/notification")).createServerNotificationState
})

test.each([
  ["session.execution.succeeded", "notification.session.responseReady.title"],
  ["session.execution.failed", "notification.session.error.title"],
] as const)("system alert for %s requires an open session tab", async (type, title) => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: "another-session" }]
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn

            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: { session: { get: () => session } } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({
    type,
    id: "event-1",
    data: { sessionID: session.id, error: { type: "api", message: "failed", status: 500 } },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(alerts).toEqual([])

  tabs.store = [{ type: "session", server, sessionId: session.id }]
  listener?.({
    type,
    id: "event-2",
    data: { sessionID: session.id, error: { type: "api", message: "failed", status: 500 } },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(alerts).toEqual([title])
  dispose.dispose()
})

test("unread state and viewing follow the server's idle and viewed watermarks", async () => {
  const views: { sessionID: string; idle: number }[] = []
  const failures = { remaining: 1 }

  type Info = {
    id: string
    parentID?: string
    time: { idle?: number; viewed?: number; archived?: number }
    location: { directory: string }
  }

  const [store, setStore] = createStore<{ viewing?: string; sessions: Record<string, Info> }>({
    sessions: {
      root: { id: "root", time: { idle: 2, viewed: 1 }, location: { directory: "/project" } },
      child: { id: "child", parentID: "root", time: { idle: 5 }, location: { directory: "/project" } },
      read: { id: "read", time: { idle: 3, viewed: 3 }, location: { directory: "/project" } },
      archived: { id: "archived", time: { idle: 4, archived: 1 }, location: { directory: "/project" } },
      other: { id: "other", time: { idle: 4 }, location: { directory: "/other" } },
    },
  })

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: { listen: () => () => {} },
        api: {
          session: {
            view: async (input: { sessionID: string; idle: number }) => {
              views.push(input)

              if (failures.remaining-- > 0) throw new Error("offline")
            },
          },
        },
      } as unknown as ServerSDK,
      data: {
        session: {
          get: (id: string) => store.sessions[id],
          root: (id: string) => store.sessions[id]?.parentID ?? id,
          list: () => Object.values(store.sessions),
        },
      } as unknown as Data,
      coordinator: {},
    } as Parameters<typeof createServerNotificationState>[0])

    // Mirrors the session route, which re-runs markViewed whenever what it reads changes.
    createEffect(() => {
      if (store.viewing) state.session.markViewed(store.viewing)
    })

    return { dispose, state }
  })

  const state = dispose.state

  // Unread reads the root session; children and archived sessions never mark a project unread.
  expect(["root", "child", "read", "other"].map((id) => state.session.unread(id))).toEqual([true, true, false, true])
  expect(state.project.hasUnread("/project")).toBe(true)

  // Viewing a child acknowledges its root's idle watermark; a failed report retries after a backoff.
  setStore("viewing", "child")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(views).toEqual([{ sessionID: "root", idle: 2 }])
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(views).toEqual([
    { sessionID: "root", idle: 2 },
    { sessionID: "root", idle: 2 },
  ])

  setStore("sessions", "root", "time", "viewed", 2)
  expect(state.session.unread("root")).toBe(false)
  expect(state.project.hasUnread("/project")).toBe(false)

  // A newer turn while the session stays open makes it unread and reports the new watermark once.
  setStore("sessions", "root", "time", "idle", 6)
  expect(state.session.unread("root")).toBe(true)
  state.project.markViewed("/project")
  state.project.markViewed("/other")
  expect(views.slice(2)).toEqual([
    { sessionID: "root", idle: 6 },
    { sessionID: "other", idle: 4 },
  ])
  dispose.dispose()
})

test("unread state honours the old local list until its viewed state is carried to the server, then deletes it", async () => {
  const key = "opencode.global.dat:notification"
  const lists: unknown[] = []
  const views: { sessionID: string; idle: number }[] = []
  const failures = { remaining: 1 }

  // The old list was found at time 10: sessions that went idle by then were read here unless the list says otherwise.
  vi.useFakeTimers()
  setSystemTime(new Date(10))
  localStorage.setItem(
    key,
    JSON.stringify({
      list: [
        { type: "turn-complete", time: 1, viewed: true, session: "read-here" },
        { type: "turn-complete", time: 2, viewed: false, session: "unread-here" },
      ],
    }),
  )

  const sessions = [
    { id: "read-here", time: { idle: 5 } },
    { id: "unread-here", time: { idle: 6 } },
    { id: "viewed", time: { idle: 4, viewed: 4 } },
    { id: "untracked", time: { idle: 7, viewed: 3 } },
    { id: "new", time: { idle: 20 } },
    { id: "never-ran", time: {} },
  ]

  const start = () =>
    createRoot((dispose) => ({
      dispose,
      state: createServerNotificationState({
        key: server,
        sdk: {
          scope: ServerScope.local,
          connection: { status: () => "connected" },
          event: { listen: () => () => {} },
          api: {
            session: {
              list: async (input: { cursor?: string }) => {
                lists.push(input)

                return input.cursor
                  ? { data: sessions.slice(3), cursor: {} }
                  : { data: sessions.slice(0, 3), cursor: { next: "second" } }
              },
              view: async (input: { sessionID: string; idle: number }) => {
                views.push(input)

                if (failures.remaining-- > 0) throw new Error("offline")
              },
            },
          },
        } as unknown as ServerSDK,
        data: { session: { get: () => undefined, root: (id: string) => id } } as unknown as Data,
        coordinator: {},
      } as Parameters<typeof createServerNotificationState>[0]),
    }))

  // Sessions come from fetched snapshots here, like home rows for sessions that aren't loaded.
  const unread = (state: ReturnType<typeof start>["state"]) =>
    // SAFETY: the snapshots carry the id and time fields unread state reads.
    sessions.filter((session) => state.session.unread(session.id, session as never)).map((session) => session.id)

  // Advances fake time, then lets the mocked requests it started settle.
  const advance = async (ms: number) => {
    vi.advanceTimersByTime(ms)

    for (const _ of Array.from({ length: 50 })) await Promise.resolve()
  }

  const first = start()
  // Until the stored list is read, nothing it had read can flash unread.
  expect(unread(first.state)).toEqual([])
  await advance(0)

  // Nothing read here lights up, while a session that went idle after the list was found is new.
  expect(unread(first.state)).toEqual(["unread-here", "new"])

  // The carry-over waits for startup to settle, then a failed report keeps the list for the next connection.
  await advance(4_999)
  expect(lists).toEqual([])
  await advance(1)
  expect(views).toEqual([{ sessionID: "read-here", idle: 5 }])
  expect(JSON.parse(localStorage.getItem(key) ?? "null")).toMatchObject({ started: 10 })
  first.dispose()

  // A later start keeps the first start's cutoff, reports every page, then deletes the list without anything flashing.
  setSystemTime(new Date(100))
  lists.length = 0
  views.length = 0
  const second = start()
  await advance(0)
  expect(unread(second.state)).toEqual(["unread-here", "new"])
  await advance(5_000)
  expect(lists).toEqual([
    { limit: 200, order: "desc", parentID: null },
    { limit: 200, order: "desc", parentID: null, cursor: "second" },
  ])
  expect(views).toEqual([
    { sessionID: "read-here", idle: 5 },
    { sessionID: "untracked", idle: 7 },
  ])
  expect(localStorage.getItem(key)).toBeNull()
  expect(unread(second.state)).toEqual(["unread-here", "new"])
  second.dispose()

  // Without the old list, later starts never touch the server's viewed state.
  const third = start()
  await advance(5_000)
  expect(lists).toHaveLength(2)
  expect(views).toHaveLength(2)
  third.dispose()
  vi.useRealTimers()
  setSystemTime()
})
