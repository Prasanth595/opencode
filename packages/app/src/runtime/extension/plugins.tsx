import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import type { Definition } from "@opencode/gui-extensions/sdk"
import type { PluginInfo } from "@opencode/client/promise"
import { usePlatform } from "@/runtime/platform/platform"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { pluginDefinition } from "./module"

type Api = NonNullable<ReturnType<ReturnType<typeof useGlobal>["serverCtx"]>>["sdk"]["api"]

/** A plugin's `./gui` bundle as this window evaluated it, at one revision. */
type Found = {
  readonly id: string
  readonly revision: string
  readonly main: boolean
  readonly definition: Definition
}

/**
 * Loads the GUI extensions of the plugins on the server that runs the app: the desktop's own server, or on the web the
 * server that served this page. That server's code is already trusted as much as the app itself, so its plugins'
 * `./gui` bundles add no new code source. Main reads each bundle from that server itself to run its `main` setup; this
 * only tells it which plugins exist.
 */
export function ExtensionPlugins(props: { onChange: (definitions: readonly Definition[]) => void }) {
  const global = useGlobal()
  const bridge = usePlatform().extensions
  const server = createMemo(() => global.servers.list().find(runsApp))

  const controller = () => {
    const conn = server()

    return conn ? global.serverCtx(ServerConnection.key(conn)) : undefined
  }

  const [version, setVersion] = createSignal(0)
  // One evaluation per plugin revision, so an unchanged plugin keeps its definition and the host does not reload it.
  const cache = new Map<string, Found>()

  // The server announces plugin inventory changes, including a local plugin whose files changed.
  createEffect(() => {
    const current = controller()

    if (!current) return
    onCleanup(current.sdk.event.on("plugin.updated", () => setVersion((value) => value + 1)))
  })

  const [found] = createResource(
    () => {
      const current = controller()

      if (!current || current.sdk.connection.status() !== "connected") return

      return { api: current.sdk.api, version: version() }
    },
    async (input) => {
      const listed = await input.api.plugin.list().then((result) => result.data)

      const plugins = await Promise.all(
        listed.filter(shipsGui).map((plugin) => find(input.api, plugin.id, cache)),
      ).then((items) => items.flatMap((item) => (item ? [item] : [])))

      const ids = new Set(plugins.map((plugin) => plugin.id))
      cache.forEach((_, id) => {
        if (!ids.has(id)) cache.delete(id)
      })

      return plugins
    },
  )

  // Syncs the found plugins out to the extension host and to main.
  createEffect(() => {
    const plugins = found.latest

    if (!plugins) return
    props.onChange(plugins.map((plugin) => plugin.definition))
    bridge?.plugins?.(plugins.map((plugin) => ({ id: plugin.id, revision: plugin.revision, main: plugin.main })))
  })

  return null
}

/** An active, non-built-in server plugin with an id that exports `./gui`. */
function shipsGui(plugin: PluginInfo): plugin is PluginInfo & { readonly id: string } {
  return !!plugin.id && plugin.source.type !== "builtin" && plugin.state.status === "active" && !!plugin.features.gui
}

/** Reads the plugin's bundle, and evaluates it when its revision is new. */
async function find(api: Api, id: string, cache: Map<string, Found>): Promise<Found | undefined> {
  const bundle = await api.plugin.gui({ id }).then(
    (result) => result.data,
    () => undefined,
  )

  if (!bundle) return undefined
  const cached = cache.get(id)

  if (cached?.revision === bundle.revision) return cached

  const evaluated = await pluginDefinition(id, bundle.source)
  const next = { id, revision: bundle.revision, ...evaluated }
  cache.set(id, next)

  return next
}

/** The server that runs this app: the desktop's own server, or the one that served this web page. */
function runsApp(conn: ServerConnection.Any) {
  if (ServerConnection.builtin(conn)) return true

  if (conn.type !== "http" || !URL.canParse(conn.http.url)) return false

  return new URL(conn.http.url).origin === window.location.origin
}
