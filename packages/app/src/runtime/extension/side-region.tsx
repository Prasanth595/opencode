import { For, Show, createEffect, createMemo, onCleanup, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { createEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { Tabs } from "@opencode/ui/tabs"
import { IconButton } from "@opencode/ui/icon-button"
import { Icon } from "@opencode/ui/icon"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { Mark } from "@opencode/ui/logo"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { Menu } from "@opencode/ui/menu"
import {
  MenuItem,
  type MountedSession,
  type SessionScreen,
  type PanelSidebar,
  type SessionPanelMenuItem,
} from "@opencode/gui-extensions/sdk"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"
import { useSessionLayout } from "@/session/session-layout"
import type { Sizing } from "@/session/helpers"
import { useExtensionHost } from "./host"
import { PanelTrigger } from "./panel-trigger"
import { RegionContent, type Region, type RegionPane } from "./panels"
import { ExtensionSlot } from "./render"
import { createTabStripScroll } from "./tab-strip-scroll"
import type { PaneDrag } from "./pane-drag"

const FILE_TREE_WIDTH_MIN = 240

const PANE_HEIGHT_MIN = 120

/** The side region: the side pane, the pane split below it, and the inner sidebar. */
export function SideRegion(props: {
  view: MountedSession
  screen: SessionScreen
  region: Region
  sidebar: PanelSidebar
  fileTree: boolean
  present?: boolean
  size: Sizing
  drag: PaneDrag
}) {
  const layout = useLayout()
  const language = useLanguage()
  const { view, params } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const tabsOpen = createMemo(() => isDesktop() && view().side.opened())
  const tabsVisible = createMemo(() => tabsOpen() || !!props.present)
  const fileOpen = createMemo(() => isDesktop() && props.fileTree)
  const open = createMemo(() => tabsOpen() || fileOpen())
  const visible = createMemo(() => tabsVisible() || fileOpen())
  const fileTreeWidth = createMemo(() => Math.max(FILE_TREE_WIDTH_MIN, layout.fileTree.width()))

  const panelWidth = createMemo(() => {
    if (!visible()) return "0px"

    if (tabsVisible()) return "auto"

    return `${fileTreeWidth()}px`
  })

  const treeWidth = createMemo(() => (fileOpen() ? `${fileTreeWidth()}px` : "0px"))

  // The split pane shows while it holds tabs; when the side pane has none, the split pane takes the whole height.
  const panes = createMemo(() => {
    const split = props.region.pane("split").keys().length > 0

    if (!split) return ["side"] as const

    if (props.region.pane("side").keys().length === 0) return ["split"] as const

    return ["side", "split"] as const
  })

  const [column, setColumn] = createStore({ height: 0 })
  let root: HTMLElement | undefined
  let stack: HTMLDivElement | undefined

  createResizeObserver(
    () => stack,
    ({ height }) => setColumn({ height }),
  )

  const lowerHeight = createMemo(() => Math.round(column.height * (1 - view().split.ratio())))

  createEffect(() => {
    if (open()) return
    const active = document.activeElement

    if (!(active instanceof HTMLElement)) return

    if (!root?.contains(active)) return
    active.blur()
  })

  return (
    <Show when={isDesktop() && !!params.id}>
      <aside
        ref={root}
        id="review-panel"
        tabIndex={-1}
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative h-full shrink-0 min-w-0 flex overflow-hidden bg-v2-background-bg-base rounded-[10px] shadow-[var(--v2-elevation-raised)] outline-none"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active(),
          "flex-1": tabsVisible(),
        }}
        style={{ width: panelWidth() }}
      >
        <Show when={visible()}>
          <div
            data-slot="session-review-content"
            class="h-full flex shrink-0"
            style={{ width: "var(--session-side-content-width, 100%)" }}
          >
            <Show when={tabsVisible()}>
              <div
                ref={stack}
                class="relative min-w-0 h-full flex-1 flex flex-col overflow-hidden bg-v2-background-bg-base"
              >
                <For each={panes()}>
                  {(pane, index) => (
                    <div
                      data-slot="session-side-pane"
                      data-pane={pane}
                      class="relative min-h-0 min-w-0 bg-v2-background-bg-base"
                      classList={{
                        "flex-1": panes().length === 1 || index() === 0,
                        "shrink-0 border-t border-border-weaker-base": index() > 0,
                      }}
                      style={index() > 0 ? { height: `${lowerHeight()}px` } : undefined}
                    >
                      <Show when={index() > 0}>
                        <div onPointerDown={() => props.size.start()}>
                          <ResizeHandle
                            direction="vertical"
                            edge="start"
                            size={lowerHeight()}
                            min={PANE_HEIGHT_MIN}
                            max={Math.max(PANE_HEIGHT_MIN, column.height - PANE_HEIGHT_MIN)}
                            onResize={(height) => {
                              props.size.touch()

                              if (column.height > 0) view().split.resize(1 - height / column.height)
                            }}
                          />
                        </div>
                      </Show>
                      <PaneTabs
                        pane={props.region.pane(pane)}
                        region={props.region}
                        view={props.view}
                        screen={props.screen}
                        sidebar={props.sidebar}
                        shown={tabsOpen}
                        present={tabsVisible}
                        animate={() => !props.size.active()}
                        placeholder={index() === 0}
                        actions={index() === 0}
                        drag={props.drag}
                      />
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={fileOpen()}>
              <div
                id="file-tree-panel"
                class="relative min-w-0 h-full shrink-0 overflow-hidden"
                classList={{
                  "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                    !props.size.active(),
                }}
                style={{ width: treeWidth() }}
              >
                <div
                  class="h-full flex flex-col overflow-hidden group/filetree"
                  classList={{ "border-l border-border-weaker-base": tabsOpen() }}
                >
                  <ExtensionSlot
                    at="session.panel.sidebar"
                    input={{
                      get session() {
                        return props.view
                      },
                      get screen() {
                        return props.screen
                      },
                    }}
                  />
                </div>
                <div onPointerDown={() => props.size.start()}>
                  <ResizeHandle
                    direction="horizontal"
                    edge="start"
                    size={fileTreeWidth()}
                    min={FILE_TREE_WIDTH_MIN}
                    max={480}
                    onResize={(width) => {
                      props.size.touch()
                      layout.fileTree.resize(width)
                    }}
                  />
                </div>
              </div>
            </Show>
          </div>
        </Show>
      </aside>
    </Show>
  )
}

/** One pane: its tab strip with the "+" menu, and the tab it shows. */
export function PaneTabs(props: {
  pane: RegionPane
  region: Region
  view: MountedSession
  screen: SessionScreen
  sidebar: PanelSidebar
  /** The pane is on screen. */
  shown: Accessor<boolean>
  /** The pane stays rendered, e.g. while it animates closed. */
  present: Accessor<boolean>
  animate: Accessor<boolean>
  drag: PaneDrag
  /** Shows the empty state while the pane selects nothing. */
  placeholder?: boolean
  /** Renders the extensions' strip actions and keeps room for the session's review toggle. */
  actions?: boolean
  /** Controls after the strip, e.g. the bottom pane's hide button. */
  end?: JSX.Element
}) {
  const language = useLanguage()
  const host = useExtensionHost()
  const { tabs } = useSessionLayout()

  const menu = createMemo(() =>
    host
      .list(MenuItem)
      .flatMap((item) => (item.menu === "session.panel" ? [item] : []))
      .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0)),
  )

  // The next tab the "+" menu opens lands in this pane.
  const target = () => tabs().target(props.pane.id)

  let selectionEvent: Event | undefined

  return (
    <Tabs
      data-pane-content={props.pane.id}
      value={props.pane.active() ?? "empty"}
      onChange={(value) => {
        // Kobalte selects the first tab while triggers register, including while the "+" menu's click is still
        // dispatching. Persist input events on a tab only; the region owns fallback selection.
        if (
          selectionEvent &&
          selectionEvent.eventPhase !== Event.NONE &&
          selectionEvent.target instanceof Element &&
          selectionEvent.target.closest('[role="tab"]')
        )
          props.region.select(value)
      }}
    >
      <div class="session-review-v2-tabs-bar sticky top-0 shrink-0 flex items-center">
        <Tabs.List
          data-pane-strip={props.pane.id}
          ref={(el: HTMLDivElement) => {
            createEventListener(el, ["pointerdown", "click", "keydown"], (event) => (selectionEvent = event), {
              capture: true,
            })
            onCleanup(createTabStripScroll({ el, lead: props.pane.lead }))
          }}
        >
          <For each={props.pane.keys()}>
            {(key) => (
              <Show when={props.region.entry(key)}>
                {(entry) => (
                  <PanelTrigger
                    value={key}
                    extension={entry().extension}
                    tab={entry().tab}
                    session={props.view}
                    active={props.pane.active() === key}
                    preview={tabs().preview() === key}
                    dragging={props.drag.dragging() === key}
                    onDragStart={(event) => props.drag.start(event, key, entry().tab.title)}
                    onClose={props.region.close}
                    onPromote={(value) => void tabs().open(value)}
                  />
                )}
              </Show>
            )}
          </For>
          <div class="h-full shrink-0 sticky end-0 z-10 flex items-center justify-center bg-v2-background-bg-base">
            <Show
              when={menu().length > 1}
              fallback={<Show when={menu()[0]}>{(item) => <AddButton item={item()} onChoose={target} />}</Show>}
            >
              <AddMenu items={menu()} onChoose={target} />
            </Show>
          </div>
        </Tabs.List>
        <div
          data-slot="session-side-panel-actions"
          class="session-review-v2-open-in-app-slot h-[var(--tabs-bar-height)] shrink-0 flex items-center gap-2 pe-3"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <Show when={props.actions}>
            <ExtensionSlot
              at="session.panel.end"
              input={{
                get session() {
                  return props.view
                },
                get screen() {
                  return props.screen
                },
              }}
            />
          </Show>
          {props.end}
          <Show when={props.actions && props.present()}>
            <div class="size-7 shrink-0" aria-hidden />
          </Show>
        </div>
      </div>

      <Show when={props.placeholder && props.pane.active() === undefined}>
        <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
            <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
              <Mark class="w-14 opacity-10" />
              <div class="text-14-regular text-text-weak max-w-56">{language.t("session.files.selectToOpen")}</div>
            </div>
          </div>
        </Tabs.Content>
      </Show>
      <RegionContent
        pane={props.pane}
        view={props.view}
        screen={props.screen}
        frame={{
          shown: props.shown,
          present: props.present,
          placement: () => "side",
          reserve: () => false,
          animate: props.animate,
          sidebar: props.sidebar,
        }}
      />
    </Tabs>
  )
}

function AddButton(props: { item: SessionPanelMenuItem; onChoose: () => void }): JSX.Element {
  const command = useCommand()
  const keybind = createMemo(() => (props.item.keybind ? command.keybindParts(props.item.keybind) : []))

  return (
    <Tooltip
      value={
        <>
          {props.item.title}
          <Show when={keybind().length > 0}>
            <Keybind keys={keybind()} variant="neutral" />
          </Show>
        </>
      }
      placement="bottom"
      class="flex items-center"
    >
      <IconButton
        icon={<Icon name="plus" />}
        variant="ghost-muted"
        size="large"
        onClick={() => {
          props.onChoose()
          props.item.run()
        }}
        aria-label={props.item.title}
      />
    </Tooltip>
  )
}

function AddMenu(props: { items: readonly SessionPanelMenuItem[]; onChoose: () => void }): JSX.Element {
  const language = useLanguage()
  const command = useCommand()
  // A chosen item runs once the closing menu has returned focus to "+", and the tab strip has passed it on to the
  // selected tab. Releasing that focus first lets the item move it where its tab needs it, e.g. into a new terminal,
  // without the strip taking it back for the tab it remembers.
  let chosen: SessionPanelMenuItem | undefined

  return (
    <Tooltip value={language.t("session.tab.add")} placement="bottom" class="flex items-center">
      <Menu appearance="standard" modal={false} placement="bottom-start" gutter={4}>
        <Menu.Trigger
          as={IconButton}
          icon={<Icon name="plus" />}
          variant="ghost-muted"
          size="large"
          aria-label={language.t("session.tab.add")}
          // The tablist redirects focus entering it to the selected
          // tab, which counts as focus-outside and closes the menu.
          onPointerDown={(event: PointerEvent) => event.preventDefault()}
        />
        <Menu.Portal>
          <Menu.Content
            onCloseAutoFocus={() => {
              const item = chosen

              if (!item) return
              chosen = undefined
              setTimeout(() => {
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
                props.onChoose()
                item.run()
              })
            }}
          >
            <For each={props.items}>
              {(item) => {
                const keybind = createMemo(() => (item.keybind ? command.keybindParts(item.keybind) : []))

                return (
                  <Menu.Item
                    class="!gap-6"
                    onSelect={() => (chosen = item)}
                    shortcut={
                      <Show when={keybind().length > 0}>
                        <Keybind keys={keybind()} variant="neutral" />
                      </Show>
                    }
                  >
                    <div class="flex items-center gap-2">
                      <Show when={item.icon}>{(icon) => <Icon name={icon()} size="small" />}</Show>
                      <span>{item.title}</span>
                    </div>
                  </Menu.Item>
                )
              }}
            </For>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </Tooltip>
  )
}
