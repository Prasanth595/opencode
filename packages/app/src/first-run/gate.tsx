import { Show, type ParentProps } from "solid-js"
import { ServerProvider } from "@/runtime/server/current"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useFirstRunDetection } from "./detection"
import { FirstRunWizard } from "./wizard"

/**
 * Renders children untouched and overlays the first-run wizard on top when
 * this looks like a first launch with no AI provider connected. Detection
 * waits for a healthy local server; until then (or when none exists) the app
 * behaves exactly as before, so a slow or missing server can never blank the
 * screen or trap the user.
 */
export function FirstRunGate(props: ParentProps) {
  return (
    <>
      {props.children}
      <FirstRunOverlay />
    </>
  )
}

function FirstRunOverlay() {
  const servers = useServers()
  const local = () => servers.list.find((item) => ServerConnection.local(item))

  return (
    <Show when={local()} keyed>
      {(conn) => (
        <ServerProvider conn={conn}>
          <FirstRunCheck />
        </ServerProvider>
      )}
    </Show>
  )
}

function FirstRunCheck() {
  const detection = useFirstRunDetection()

  return (
    <Show when={detection.show()}>
      <FirstRunWizard onDone={detection.dismiss} />
    </Show>
  )
}
