import { createEffect, createMemo, For, mergeProps, on, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { Schema } from "effect"
import { createMediaQuery } from "@solid-primitives/media"
import {
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_DEFAULT,
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX,
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN,
} from "@opencode/session-ui/v2/session-review-v2"
import {
  Panel,
  PanelContext,
  type PanelFrame,
  type PanelSidebar,
  type PanelTab,
  type MountedSession,
  type SessionScreen,
} from "@opencode/gui-extensions/sdk"
import { same } from "@/runtime/persistence/equality"
import { sessionTabPane, type SessionPane, type SessionTabs } from "@/shell/state/session-tabs"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { useExtensionHost } from "./host"
import { Contribution } from "./render"
import { useExtensionAttachment } from "./attachment"
import { legacyKeys, panelKey } from "./panel-keys"

type Tabs = Accessor<{
  tabs(): SessionTabs
  all(): string[]
  active(): string | undefined
  setAll(all: string[]): void
  setActive(tab: string | undefined): void
  close(tab: string): void
  remap(rewrite: (tab: string) => string): void
}>

export type RegionEntry = {
  readonly key: string
  readonly extension: string
  readonly tab: PanelTab
  readonly provider: Panel
}

/** One pane of the region: its tabs, in strip order, and the tab it shows. */
export type RegionPane = {
  readonly id: SessionPane
  /** Every tab listed in the pane, stored or not. */
  readonly entries: Accessor<RegionEntry[]>
  /** Drawn strip order by key. Renders iterate keys so a provider's fresh tab objects never remount a trigger. */
  readonly keys: Accessor<string[]>
  readonly active: Accessor<string | undefined>
  readonly selected: Accessor<RegionEntry | undefined>
  /** An extension's tab ids stored in this pane. */
  readonly openFor: (extension: string) => string[]
  readonly lead: () => boolean
}

const SidebarState = Persistence.struct({
  sidebarOpened: Schema.Boolean,
  sidebarWidth: Schema.Finite.check(
    Schema.isBetween({ minimum: SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN, maximum: SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX }),
  ),
  expandMode: Schema.Literals(["expand", "collapse"]),
})

/**
 * The inner sidebar preference every side panel shares. The key predates extensions. `Layout.sidebar` reads it while
 * the session screen that created it is mounted.
 */
export function createPanelSidebar(): PanelSidebar {
  const [store, setStore, , ready] = persisted(Persist.global("review-panel-v2"), SidebarState, {
    sidebarOpened: true,
    sidebarWidth: SESSION_REVIEW_V2_SIDEBAR_WIDTH_DEFAULT,
    expandMode: "collapse",
  })

  const sidebar: PanelSidebar = {
    opened: () => store.sidebarOpened,
    width: () => store.sidebarWidth,
    transition: ready,
    resize: (width) =>
      setStore(
        "sidebarWidth",
        Math.min(SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX, Math.max(SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN, width)),
      ),
    toggle: () => setStore("sidebarOpened", (opened) => !opened),
  }

  onCleanup(useExtensionAttachment().sidebar(sidebar))

  return sidebar
}

/**
 * Every panel extensions offer in one region of the routed session, merged with the stored strip. `view` returns the
 * routed session's object, a new one per routed session.
 */
export function createRegion(input: {
  region: Panel["region"]
  view: Accessor<MountedSession>
  screen: SessionScreen
  tabs: Tabs
}) {
  const host = useExtensionHost()
  const stored = () => input.tabs().all()
  const providers = createMemo(() => host.items(Panel).filter((item) => item.value.region === input.region))

  const entries = createMemo(() =>
    providers().flatMap((item) => {
      const prefix = `${item.extension}:`
      const open = stored().flatMap((key) => (key.startsWith(prefix) ? [key.slice(prefix.length)] : []))

      return item.value.list(panelInput(input.view, input.screen, { open })).map(
        (tab): RegionEntry => ({
          key: panelKey(item.extension, tab.id),
          extension: item.extension,
          tab,
          provider: item.value,
        }),
      )
    }),
  )

  const byKey = createMemo(() => new Map(entries().map((entry) => [entry.key, entry])))

  // Rewrites stored keys once their panel is present: keys stored before extensions (e.g. "context") or under an
  // extension's earlier id, and ids a panel writes more than one way. Duplicates collapse, so one file stored two ways
  // is one tab.
  createEffect(() => {
    const legacy = legacyKeys(providers())
    const normalizers = providers().flatMap((item) => (item.value.normalize ? [item] : []))

    if (legacy.size === 0 && normalizers.length === 0) return

    const rewrite = (key: string) => {
      const moved = legacy.get(key)

      if (moved) return moved
      const item = normalizers.find((provider) => key.startsWith(`${provider.extension}:`))

      if (!item?.value.normalize) return key

      return panelKey(
        item.extension,
        item.value.normalize(
          panelInput(input.view, input.screen, {
            id: key.slice(item.extension.length + 1),
          }),
        ),
      )
    }

    // remap reads the stored tabs and writes nothing once every key is canonical, so this settles in one rerun.
    input.tabs().remap(rewrite)
  })

  // Transient panels are not restored: their stored keys leave once the panel stops listing them.
  createEffect(() => {
    const listed = new Set(entries().map((entry) => entry.key))
    const transient = providers().flatMap((item) => (item.value.transient ? [`${item.extension}:`] : []))

    if (transient.length === 0) return
    const all = stored()
    const next = all.filter((key) => listed.has(key) || !transient.some((prefix) => key.startsWith(prefix)))

    if (next.length !== all.length) input.tabs().setAll(next)
  })

  const strip = createMemo(() => {
    const listed = stored().flatMap((key) => {
      const entry = byKey().get(key)

      return entry && !entry.tab.pinned ? [entry] : []
    })

    return [
      ...entries().filter((entry) => entry.tab.pinned),
      ...listed.filter((entry) => entry.tab.first),
      ...listed.filter((entry) => !entry.tab.first),
    ]
  })

  // A pinned tab shows in the side pane. A listed tab the strip does not store, e.g. a terminal another session opened,
  // belongs with its extension's last stored tab, so a grouped render stays in one pane.
  const paneOf = (entry: RegionEntry): SessionPane => {
    const tabs = input.tabs().tabs()

    if (entry.tab.pinned) return "side"

    if (tabs.all.includes(entry.key)) return sessionTabPane(tabs, entry.key)
    const sibling = tabs.all.findLast((key) => key.startsWith(`${entry.extension}:`))

    return sibling ? sessionTabPane(tabs, sibling) : "side"
  }

  // Narrow screens never select a transient tab: a stored one falls back like a missing tab.
  const desktop = createMediaQuery("(min-width: 768px)")

  const active = createMemo(() => {
    const value = input.tabs().active()

    if (value && strip().some((entry) => entry.key === value && (desktop() || !entry.tab.transient))) return value

    const eligible = strip().filter(
      (entry) => paneOf(entry) === "side" && entry.tab.fallback && (desktop() || !entry.tab.transient),
    )

    return [
      ...eligible.filter((entry) => !entry.tab.pinned && !entry.tab.first),
      ...eligible.filter((entry) => !entry.tab.pinned && entry.tab.first),
      ...eligible.filter((entry) => entry.tab.pinned),
    ][0]?.key
  })

  // The effect's own value marks its first run: the selection the region mounts with, stored or fallback.
  createEffect(
    on(active, (key, _, restored: boolean = true) => {
      const entry = key ? byKey().get(key) : undefined

      if (entry)
        entry.provider.focus?.(
          panelInput(input.view, input.screen, {
            tab: entry.tab,
            restored,
          }),
        )

      return false
    }),
  )

  const createPane = (pane: SessionPane): RegionPane => {
    const paneStrip = createMemo(() => strip().filter((entry) => paneOf(entry) === pane))
    const drawn = createMemo(() => paneStrip().filter((entry) => !entry.tab.hidden))

    const paneActive = createMemo(() => {
      const key = active()
      const members = paneStrip()

      if (key && members.some((entry) => entry.key === key)) return key
      const shown = input.tabs().tabs().selected?.[pane]

      if (shown && members.some((entry) => entry.key === shown && (desktop() || !entry.tab.transient))) return shown

      if (pane !== "side") return members[0]?.key
      const eligible = members.filter((entry) => entry.tab.fallback && (desktop() || !entry.tab.transient))

      return [
        ...eligible.filter((entry) => !entry.tab.pinned && !entry.tab.first),
        ...eligible.filter((entry) => !entry.tab.pinned && entry.tab.first),
        ...eligible.filter((entry) => entry.tab.pinned),
      ][0]?.key
    })

    return {
      id: pane,
      entries: createMemo(() => entries().filter((entry) => paneOf(entry) === pane)),
      keys: createMemo(() => drawn().map((entry) => entry.key), [], { equals: same }),
      active: paneActive,
      selected: createMemo(() => {
        const key = paneActive()

        return key ? byKey().get(key) : undefined
      }),
      openFor: (extension: string) =>
        stored().flatMap((key) =>
          key.startsWith(`${extension}:`) && sessionTabPane(input.tabs().tabs(), key) === pane
            ? [key.slice(extension.length + 1)]
            : [],
        ),
      lead: () => !!drawn().find((entry) => !entry.tab.pinned)?.tab.first,
    }
  }

  const panes: Record<SessionPane, RegionPane> = {
    side: createPane("side"),
    split: createPane("split"),
    bottom: createPane("bottom"),
  }

  const activePane = createMemo(() => {
    const entry = byKey().get(active() ?? "")

    return entry ? paneOf(entry) : "side"
  })

  return {
    entries,
    /** The drawn strip of the pane that holds the selected tab, by key. */
    keys: () => panes[activePane()].keys(),
    entry: (key: string) => byKey().get(key),
    active,
    selected: createMemo(() => {
      const key = active()

      return key ? byKey().get(key) : undefined
    }),
    pane: (pane: SessionPane) => panes[pane],
    paneOf: (key: string): SessionPane => {
      const entry = byKey().get(key)

      return entry ? paneOf(entry) : sessionTabPane(input.tabs().tabs(), key)
    },
    wide: createMemo(() => providers().some((item) => item.value.wide)),
    /** An extension's tab ids in the stored strip. */
    openFor: (extension: string) =>
      stored().flatMap((key) => (key.startsWith(`${extension}:`) ? [key.slice(extension.length + 1)] : [])),
    select(key: string) {
      input.tabs().setActive(key)
    },
    close(key: string) {
      const entry = byKey().get(key)
      input.tabs().close(key)

      if (entry)
        entry.provider.close?.(
          panelInput(input.view, input.screen, {
            tab: entry.tab,
          }),
        )
    },
  }
}

export type Region = ReturnType<typeof createRegion>

/** Grouped content stays mounted while any member is listed; other tabs mount only while selected. */
export function RegionContent(props: {
  pane: RegionPane
  view: MountedSession
  screen: SessionScreen
  frame: Omit<PanelFrame, "visible" | "open"> & { shown: Accessor<boolean> }
}) {
  const groups = createMemo(() =>
    Array.from(new Set(props.pane.entries().flatMap((entry) => (entry.tab.group ? [groupKey(entry)] : [])))),
  )

  const single = createMemo(() => {
    const entry = props.pane.selected()

    return entry && !entry.tab.group ? entry.key : undefined
  })

  return (
    <>
      <For each={groups()}>
        {(group) => {
          const active = () => {
            const entry = props.pane.selected()

            return !!entry && groupKey(entry) === group
          }

          // The last selected member keeps rendering while the group is hidden.
          const member = createMemo<RegionEntry | undefined>((previous) => {
            const members = props.pane.entries().filter((entry) => groupKey(entry) === group)
            const selected = props.pane.selected()

            if (selected && groupKey(selected) === group) return selected

            return members.find((entry) => entry.key === previous?.key) ?? members[0]
          })

          return (
            <Show when={member()?.extension} keyed>
              {(extension) => (
                <div
                  id={member()?.tab.dom?.panel}
                  role="tabpanel"
                  aria-labelledby={active() && !member()?.tab.hidden ? member()?.tab.dom?.tab : undefined}
                  data-slot="tabs-content"
                  class="h-full min-h-0 overflow-hidden"
                  classList={{ hidden: !active() }}
                  inert={!active() || undefined}
                >
                  <PanelContext.Provider
                    value={{
                      ...props.frame,
                      visible: () => props.frame.shown() && active(),
                      open: () => props.pane.openFor(extension),
                    }}
                  >
                    <Contribution extension={extension}>
                      {() =>
                        member()!.provider.render(
                          panelInput(() => props.view, props.screen, {
                            get tab() {
                              return member()!.tab
                            },
                          }),
                        )
                      }
                    </Contribution>
                  </PanelContext.Provider>
                </div>
              )}
            </Show>
          )
        }}
      </For>
      <Show when={single()} keyed>
        {(key) => {
          const entry = createMemo(() => props.pane.entries().find((item) => item.key === key))

          return (
            <Show when={entry()?.extension} keyed>
              {(extension) => (
                <div
                  id={entry()?.tab.dom?.panel}
                  role="tabpanel"
                  aria-labelledby={entry()?.tab.hidden ? undefined : entry()?.tab.dom?.tab}
                  tabIndex={entry()?.tab.tabbable ? 0 : undefined}
                  data-slot="tabs-content"
                  class="flex flex-col h-full overflow-hidden contain-strict"
                >
                  <PanelContext.Provider
                    value={{ ...props.frame, visible: props.frame.shown, open: () => props.pane.openFor(extension) }}
                  >
                    <Contribution extension={extension}>
                      {() =>
                        entry()!.provider.render(
                          panelInput(() => props.view, props.screen, {
                            get tab() {
                              return entry()!.tab
                            },
                          }),
                        )
                      }
                    </Contribution>
                  </PanelContext.Provider>
                </div>
              )}
            </Show>
          )
        }}
      </Show>
    </>
  )
}

function groupKey(entry: RegionEntry) {
  return `${entry.extension}/${entry.tab.group ?? entry.key}`
}

/** Keeps session and tab getters live while the owning screen stays constant. Spreading would snapshot getters. */
function panelInput<T extends object>(view: Accessor<MountedSession>, screen: SessionScreen, fields: T) {
  return mergeProps(
    {
      get session() {
        return view()
      },
      screen,
    },
    fields,
  )
}

/** Renders one panel as a narrow-screen view. */
export function MobilePanel(props: {
  entry: RegionEntry
  view: MountedSession
  screen: SessionScreen
  sidebar: PanelSidebar
  visible: boolean
  open: Accessor<readonly string[]>
}): JSX.Element {
  return (
    <PanelContext.Provider
      value={{
        visible: () => props.visible,
        present: () => props.visible,
        placement: () => "mobile",
        reserve: () => false,
        animate: () => true,
        sidebar: props.sidebar,
        open: props.open,
      }}
    >
      <Contribution extension={props.entry.extension}>
        {() =>
          props.entry.provider.render(
            panelInput(() => props.view, props.screen, {
              get tab() {
                return props.entry.tab
              },
            }),
          )
        }
      </Contribution>
    </PanelContext.Provider>
  )
}
