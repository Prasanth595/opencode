import { useSessionParams } from "@/shell/routes/session"
import { SessionID } from "@opencode/schema/session-id"
import { Route, useBeforeLeave } from "@solidjs/router"
import { createMemo, lazy, onCleanup, Show, Suspense, type ParentProps } from "solid-js"
import { Home } from "@/home/route"
import { ServerProvider } from "@/runtime/server/current"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { SessionPanelFrame, SessionRouteFrame } from "@/session/session-frame"
import { LayoutProvider } from "@/shell/state/layout"
import { SettingsSurfaceProvider } from "@/settings/surface"
import Shell from "@/shell/shell"
import { requireServerKey } from "./session"
import { ExtensionAttachment } from "@/runtime/extension/root"
import { useTabs } from "@/shell/tabs/tabs"

export const File = lazy(() => import("@opencode/session-ui/file").then((module) => ({ default: module.File })))

const loadSessionRoute = () => Promise.all([import("@/session/route"), File.preload()]).then(([module]) => module)

const DraftRoute = lazy(() => import("@/new-session/route").then((module) => ({ default: module.DraftRoute })))

const SettingsScreen = lazy(() => import("@/settings/shell").then((module) => ({ default: module.SettingsScreen })))

const ConnectServerScreen = lazy(() =>
  import("@/servers/connect/screen").then((module) => ({ default: module.ConnectServerScreen })),
)

const TargetSessionRouteContent = lazy(() =>
  loadSessionRoute().then((module) => ({ default: module.TargetSessionRouteContent })),
)

export function preloadRoute(url: string) {
  const pathname = url.split(/[?#]/, 1)[0]

  if (pathname === "/new-session") return DraftRoute.preload().then(() => undefined)

  if (pathname === "/settings") return SettingsScreen.preload().then(() => undefined)

  if (/^\/server\/[^/]+\/session\/[^/]+$/.test(pathname))
    return TargetSessionRouteContent.preload().then(() => undefined)

  return Promise.resolve()
}

export function AppRoutes() {
  return (
    <Route component={AppLayout}>
      <Route path="/" component={Home} />
      <Route path="/settings" component={SettingsScreen} />
      <Route
        path="/server/:serverKey/session/:id"
        component={() => (
          <SessionRouteFrame>
            <Suspense
              fallback={
                <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
                  <SessionPanelFrame raised />
                </div>
              }
            >
              <TargetServerRoute>
                <TargetSessionRouteContent />
              </TargetServerRoute>
            </Suspense>
          </SessionRouteFrame>
        )}
      />
      <Route path="/new-session" component={DraftRoute} />
    </Route>
  )
}

function TargetServerRoute(props: ParentProps) {
  const params = useSessionParams()
  const global = useGlobal()

  const connection = createMemo(() =>
    global.servers.list().find((item) => ServerConnection.key(item) === requireServerKey(params.serverKey)),
  )

  return (
    <Show when={connection()} keyed>
      {(connection) => <ServerProvider conn={connection}>{props.children}</ServerProvider>}
    </Show>
  )
}

function AppLayout(props: ParentProps) {
  const servers = useServers()
  const global = useGlobal()
  const tabs = useTabs()
  let navigation = 0
  onCleanup(() => navigation++)
  useBeforeLeave((event) => {
    const current = ++navigation
    const selection = tabs.selectionVersion()
    if (event.defaultPrevented || typeof event.to !== "string") return
    const from = event.from.pathname.match(/^\/server\/([^/]+)\/session\/([^/]+)$/)
    if (!from && event.from.pathname !== "/new-session") return
    // Draft promotion removes its tab and navigates in the same transition.
    if (!from) {
      const draftID = new URLSearchParams(event.from.search).get("draftId")
      if (!tabs.store.some((tab) => tab.type === "draft" && tab.draftID === draftID)) return
    }
    if (from && tabs.pendingSession(requireServerKey(from[1]), SessionID.make(from[2], { disableChecks: true }))) return
    const pathname = event.to.split(/[?#]/, 1)[0]
    if (pathname === event.from.pathname) return
    const match = pathname.match(/^\/server\/([^/]+)\/session\/([^/]+)$/)
    if (!match) return
    const key = requireServerKey(match[1])
    const id = SessionID.make(match[2], { disableChecks: true })
    const server = global.serverCtx(key)
    if (!server || tabs.pendingSession(key, id)) return
    // Keep the current view mounted while the destination's lazy route, history,
    // and tail Markdown load. Its virtualizer can then measure before the first paint.
    event.preventDefault()
    void TargetSessionRouteContent.preload()
      .then(loadSessionRoute)
      .then((route) => route.preloadSession(server.data, id))
      .catch(() => undefined)
      .then(() => {
        if (current === navigation && selection === tabs.selectionVersion()) event.retry(true)
      })
  })
  // A lone server that rejects our credentials (e.g. the web app before pairing) has nothing else to show.
  const signedOut = () => {
    const only = servers.list.length === 1 ? servers.list[0] : undefined

    if (only?.type !== "http") return

    return global.servers.health[ServerConnection.key(only)]?.unauthorized ? only : undefined
  }

  return (
    <Show when={servers.list.length > 0 && !signedOut()} fallback={<ConnectServerScreen url={signedOut()?.http.url} />}>
      <LayoutProvider>
        <SettingsSurfaceProvider>
          <ExtensionAttachment>
            <Shell>{props.children}</Shell>
          </ExtensionAttachment>
        </SettingsSurfaceProvider>
      </LayoutProvider>
    </Show>
  )
}
