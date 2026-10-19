import { createMemo, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLayout } from "@/shell/state/layout"
import { useSettings } from "@/settings/model"
import { createSizing } from "./helpers"
import type { SessionModel } from "./model"
import { clampSessionPanelWidth, sessionPanelWidthMax } from "./session-panel-width"

/** wide asks for the wider session minimum; sidebar is whether any extension fills the side panel sidebar. */
export function createSessionScreenLayout(
  session: SessionModel,
  input: { wide: Accessor<boolean>; sidebar: Accessor<boolean> },
) {
  const layout = useLayout()
  const settings = useSettings()
  const size = createSizing()
  const view = session.layout.view
  const tabsOpen = createMemo(() => session.isDesktop() && view().side.opened() && !!session.identity.params.id)

  const fileTreeOpen = createMemo(
    () => session.isDesktop() && input.sidebar() && settings.visibility.fileTree() && layout.fileTree.opened(),
  )

  const besideOpen = createMemo(() => tabsOpen() || fileTreeOpen())
  const [rowSize, setRowSize] = createStore<{ width?: number }>({})
  let row: HTMLDivElement | undefined
  createResizeObserver(
    () => row,
    ({ width }) => setRowSize({ width }),
  )

  const available = createMemo<number | undefined>(() => {
    const width = rowSize.width

    if (width === undefined) return undefined

    return width - 8
  })

  const splitSide = createMemo(() => tabsOpen() && input.wide())

  const resizedWidth = createMemo(() =>
    clampSessionPanelWidth({
      width: view().session.width(),
      available: available(),
      split: splitSide(),
    }),
  )

  const panelWidth = createMemo(() => {
    if (!besideOpen()) return "100%"

    if (tabsOpen()) return `${resizedWidth()}px`

    return `calc(100% - ${layout.fileTree.width()}px)`
  })

  const panelMax = createMemo(() => {
    const width = available()

    if (width === undefined) return 1000

    return sessionPanelWidthMax({ available: width, split: splitSide() })
  })

  const sideOpen = createMemo(() => tabsOpen() || fileTreeOpen())

  const sideContentWidth = createMemo<string>((previous) => {
    const width = available()

    if (tabsOpen() && width !== undefined) return `${Math.max(0, width - resizedWidth())}px`

    if (fileTreeOpen()) return `${layout.fileTree.width()}px`

    return previous
  }, "100%")

  return {
    centered: createMemo(() => session.isDesktop()),
    files: { open: fileTreeOpen },
    panel: {
      max: panelMax,
      ref: (element: HTMLDivElement) => {
        row = element
      },
      resizable: tabsOpen,
      resizedWidth,
      width: panelWidth,
    },
    side: {
      contentWidth: sideContentWidth,
      open: sideOpen,
      tabs: { open: tabsOpen },
    },
    size,
  }
}

export type SessionScreenLayout = ReturnType<typeof createSessionScreenLayout>
