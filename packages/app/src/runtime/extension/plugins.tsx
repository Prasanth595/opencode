import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import type { Definition, PluginOptions } from "@opencode/plugin/gui"
import { pluginIdAvailable, shipsPluginGui, type Bridge } from "@opencode/plugin/gui/host"
import type { OpenCodeClient, PluginApi } from "@opencode/client/promise"
import { usePlatform } from "@/runtime/platform/platform"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { builtins } from "./builtins"
import { pluginDefinition } from "./module"

/** A plugin's `./gui` bundle as this window evaluated it, at one revision; none when it could not be read. */
type Loaded = {
  readonly id: string
  readonly revision?: string
  readonly definition: Definition
  readonly options: PluginOptions
}

/** A plugin's GUI as the extension host runs it: its definition, options, and the client of the server that runs it. */
export type PluginGui = {
  readonly definition: Definition
  readonly options: PluginOptions
  readonly client: () => OpenCodeClient | undefined
}

/**
 * Loads the GUIs of the plugins on the desktop app's own server. That server already runs the plugins' server entries,
 * so their `./gui` bundles add no new source of code; other servers' plugins load no GUI. Main lists and reads the
 * plugins from that server itself to run their `main` setups; this only tells it when they may have changed.
 *
 * Mounted below the app's server providers, which the extension root sits above, so it hands the definitions up
 * through `onChange` rather than the root reading them.
 */
export function PluginGuiLoader(props: {
  bridge: Bridge
  /** The GUIs that load, and the ids of plugins whose GUI cannot load because a built-in claims the id. */
  onChange: (plugins: readonly PluginGui[], reserved: readonly string[]) => void
}) {
  const global = useGlobal()
  const platform = usePlatform()
  const os = platform.platform === "desktop" ? platform.os : undefined

  const controller = createMemo(() => {
    const conn = global.servers.list().find(ServerConnection.builtin)

    return conn ? global.serverCtx(ServerConnection.key(conn)) : undefined
  })

  const [version, setVersion] = createSignal(0)
  // One evaluation per plugin revision, so an unchanged plugin keeps its definition and the host does not reload it.
  const cache = new Map<string, Loaded>()

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

      return { api: current.sdk.api.plugin, version: version() }
    },
    async (input, info): Promise<{ readonly plugins: readonly Loaded[]; readonly reserved: readonly string[] }> => {
      // A failed listing keeps the plugins this window already runs; the next update or reconnect lists them again.
      const listed = await input.api.list().then(
        (result) => result.data,
        () => undefined,
      )

      if (!listed) return info.value ?? { plugins: [], reserved: [] }

      const shipped = listed.filter(shipsPluginGui)
      const reserved = shipped.flatMap((plugin) => (pluginIdAvailable(plugin.id, builtins) ? [] : [plugin.id]))

      const plugins = await Promise.all(
        shipped.filter((plugin) => !reserved.includes(plugin.id)).map((plugin) => load(input.api, plugin.id, cache)),
      )

      const ids = new Set(plugins.map((plugin) => plugin.id))
      cache.forEach((_, id) => {
        if (!ids.has(id)) cache.delete(id)
      })

      return {
        plugins: plugins.filter((plugin) => !plugin.definition.os || (!!os && plugin.definition.os.includes(os))),
        reserved,
      }
    },
  )

  // Syncs the found plugins out to the extension host and to main.
  createEffect(() => {
    const latest = found.latest

    if (!latest) return
    const plugins = latest.plugins
    // The server that runs the plugin, read each time: it is a new client after that server restarts.
    const client = () => controller()?.sdk.api
    props.onChange(
      plugins.map((plugin) => ({ definition: plugin.definition, options: plugin.options, client })),
      latest.reserved,
    )
    // Main lists the plugins from that server itself; the window only says when to look.
    props.bridge.pluginsChanged()
  })

  return null
}

/**
 * Reads a plugin's bundle and evaluates it when its revision is new. A bundle that cannot be read keeps the revision
 * this window already runs, or becomes a definition that fails, so Settings > Plugins reports it.
 */
async function load(api: PluginApi, id: string, cache: Map<string, Loaded>): Promise<Loaded> {
  const cached = cache.get(id)

  const bundle = await api.gui({ id }).then(
    (result) => ({ ok: true as const, value: result.data }),
    (cause: unknown) => ({ ok: false as const, cause }),
  )

  if (!bundle.ok) return cached ?? { id, options: {}, definition: { id, renderer: () => Promise.reject(bundle.cause) } }

  if (cached?.revision === bundle.value.revision) return cached

  const next = {
    id,
    revision: bundle.value.revision,
    options: bundle.value.options,
    definition: await pluginDefinition(id, bundle.value.code),
  }

  cache.set(id, next)

  return next
}
