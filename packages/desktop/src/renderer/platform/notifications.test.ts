import { afterEach, describe, expect, test } from "bun:test"
import { createDesktopNotify } from "./notifications"

const originalNotification = globalThis.Notification

let latestRef: WeakRef<FakeNotification> | undefined

const events: string[] = []

class FakeNotification extends EventTarget implements Notification {
  static readonly permission: NotificationPermission = "granted"

  static async requestPermission(): Promise<NotificationPermission> {
    return "granted"
  }

  onclick: ((this: Notification, ev: Event) => void) | null = null
  onclose: ((this: Notification, ev: Event) => void) | null = null
  onerror: ((this: Notification, ev: Event) => void) | null = null
  onshow: ((this: Notification, ev: Event) => void) | null = null

  readonly body: string
  readonly data = null
  readonly dir: NotificationDirection = "auto"
  readonly icon: string
  readonly lang = ""
  readonly silent: boolean | null
  readonly tag = ""
  readonly title: string

  constructor(title: string, options?: NotificationOptions) {
    super()
    this.title = title
    this.body = options?.body ?? ""
    this.icon = options?.icon ?? ""
    this.silent = options?.silent ?? null
    events.push(`created:${title}:${this.body}`)
    latestRef = new WeakRef(this)
  }

  close() {
    events.push("notification.close")
    this.onclose?.call(this, new Event("close"))
  }
}

afterEach(() => {
  events.length = 0
  latestRef = undefined
  globalThis.Notification = originalNotification
})

function flushGc() {
  return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
    Bun.gc(true)
  })
}

describe("desktop notifications", () => {
  test("retains active Notification across GC, shows and focuses the window on click, and releases it on close", async () => {
    globalThis.Notification = FakeNotification

    const notify = createDesktopNotify({
      getWindowFocused: async () => false,
      showWindow: async () => {
        events.push("api.showWindow")
      },
      setWindowFocus: async () => {
        events.push("api.setWindowFocus")
      },
    })

    await notify("Response ready", "Refactor auth flow", () => {
      events.push("session.select")
    })

    await flushGc()

    const live = latestRef?.deref()
    expect(live).toBeDefined()
    live?.onclick?.call(live, new Event("click"))

    expect(events).toEqual([
      "created:Response ready:Refactor auth flow",
      "api.showWindow",
      "api.setWindowFocus",
      "session.select",
      "notification.close",
    ])

    await flushGc()
    expect(latestRef?.deref()).toBeUndefined()
  })

  test.each([{ event: "close" as const }, { event: "error" as const }])(
    "releases the Notification wrapper when $event fires without a click",
    async ({ event }) => {
      globalThis.Notification = FakeNotification

      const notify = createDesktopNotify({
        getWindowFocused: async () => false,
        showWindow: async () => {},
        setWindowFocus: async () => {},
      })

      await notify("Session error")
      await flushGc()

      const live = latestRef?.deref()
      expect(live).toBeDefined()

      if (event === "close") {
        live?.onclose?.call(live, new Event("close"))
      } else {
        live?.onerror?.call(live, new Event("error"))
      }

      await flushGc()
      expect(latestRef?.deref()).toBeUndefined()
    },
  )

  test("suppresses desktop notifications while the window is already focused", async () => {
    globalThis.Notification = FakeNotification

    const notify = createDesktopNotify({
      getWindowFocused: async () => true,
      showWindow: async () => {},
      setWindowFocus: async () => {},
    })

    await notify("Response ready", "Active session")
    expect(events).toEqual([])
    expect(latestRef).toBeUndefined()
  })
})
