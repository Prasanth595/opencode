import { batch, createMemo, createSignal, lazy, onCleanup, Show, Suspense, type ParentProps } from "solid-js"
import { extensionEnabled, type Bridge } from "@opencode/plugin/gui/host"
import type { Definition } from "@opencode/plugin/gui"
import { builtins } from "./builtins"
import { createInstalled } from "./installed"
import { PluginGuiLoader, type PluginGui } from "./plugins"
import { createMenubarItems, MenubarItemsProvider } from "./menubar-items"
import { usePlatform } from "@/runtime/platform/platform"
import { ExtensionHostProvider, useExtensionHost } from "./host"
import { createIpcClients } from "./ipc"
import { createExtensionAttachment, createHostApis, ExtensionAttachmentProvider, type HostApis } from "./host-apis"
import { ExtensionCommands } from "./commands"
import { ExtensionStyles } from "./render"
import { ExtensionServersProvider } from "./servers"
import { ExtensionServerEndpoints } from "./server-shell"
import { createContext, useContext } from "solid-js"

const HostApisContext = createContext<HostApis>()

// Desktop only: a window loads plugin GUIs from the app's own server and tells main when they change.
const PluginsContext = createContext<{
  bridge: Bridge
  set: (plugins: readonly PluginGui[], reserved: readonly string[]) => void
  reserved: () => readonly string[]
}>()

const ExtensionHotReload = import.meta.env.DEV ? lazy(() => import("./hmr")) : undefined

/** The ids of plugins on the app's own server whose GUI cannot load because a built-in plugin claims the id. */
export function useReservedPlugins() {
  const plugins = useContext(PluginsContext)

  return () => plugins?.reserved() ?? []
}

export function useHostApis() {
  const value = useContext(HostApisContext)

  if (!value) throw new Error("Host APIs are unavailable")

  return value
}

/** Mounts the extension host for the window. Lives above the app interface so extensions can contribute servers. */
export function ExtensionRoot(props: ParentProps) {
  const platform = usePlatform()
  const apis = createHostApis()
  const bridge = platform.extensions
  const menubar = createMenubarItems(bridge)
  const ipcs = createIpcClients(bridge)
  onCleanup(ipcs.dispose)
  const installed = createInstalled(bridge)

  const os = platform.platform === "desktop" ? platform.os : undefined

  const localBuiltins = builtins.filter(
    (definition: Definition) => !definition.os || (!!os && definition.os.includes(os)),
  )

  // The GUIs of the plugins on the app's own server, found once the app interface lists its servers.
  const [plugins, setPlugins] = createSignal<readonly PluginGui[]>([])
  // Plugins whose GUI cannot load because a built-in claims the id; Settings > Plugins reports them.
  const [reserved, setReserved] = createSignal<readonly string[]>([])

  // The same definitions in the same order are no change, so a refetch that found nothing new restarts nothing.
  const definitions = createMemo<readonly Definition[]>(
    () => [...localBuiltins, ...plugins().map((plugin) => plugin.definition)],
    [],
    {
      equals: (a, b) => a.length === b.length && a.every((definition, index) => definition === b[index]),
    },
  )

  // Only enable preferences cross this boundary; the host derives blocked status from live hard dependencies.
  const disabled = createMemo(() => {
    const state = installed.enableState()

    if (!state) return undefined

    return new Set(
      definitions().flatMap((definition) => (extensionEnabled(definition.id, state) ? [] : [definition.id])),
    )
  })

  const failed = (id: string) => installed.list().some((item) => item.id === id && item.error !== undefined)

  return (
    <HostApisContext.Provider value={apis}>
      <PluginsContext.Provider
        value={
          bridge && {
            bridge,
            set: (next, ids) =>
              batch(() => {
                setPlugins(next)
                setReserved(ids)
              }),
            reserved,
          }
        }
      >
        <ExtensionHostProvider
          definitions={definitions}
          disabled={disabled}
          apis={apis.apis}
          whenMounted={apis.whenMounted}
          ipc={bridge ? (token) => ipcs.client(token) : undefined}
          plugin={(id) => plugins().find((plugin) => plugin.definition.id === id)}
          generation={ipcs.generation}
          failed={failed}
        >
          <ExtensionStyles />
          {ExtensionHotReload && (
            <Suspense>
              <ExtensionHotReload />
            </Suspense>
          )}
          <MenubarItemsProvider value={menubar}>
            <ExtensionServersProvider failed={failed}>{props.children}</ExtensionServersProvider>
          </MenubarItemsProvider>
        </ExtensionHostProvider>
      </PluginsContext.Provider>
    </HostApisContext.Provider>
  )
}

/** Attaches the session and layout HostApis and publishes extension commands. Renders once extensions are active. */
export function ExtensionAttachment(props: ParentProps) {
  const host = useExtensionHost()
  const attachment = createExtensionAttachment(useHostApis())
  const plugins = useContext(PluginsContext)

  return (
    <ExtensionAttachmentProvider value={attachment}>
      <ExtensionCommands />
      <ExtensionServerEndpoints />
      <Show when={plugins}>{(value) => <PluginGuiLoader bridge={value().bridge} onChange={value().set} />}</Show>
      <Show when={host.ready()}>
        <MountedInterface attach={attachment.attach} />
        {props.children}
      </Show>
    </ExtensionAttachmentProvider>
  )
}

/**
 * The app interface as the HostApis see it, mounted as the routes first render and not before: writes and dialogs made
 * while extensions set up wait until then.
 */
function MountedInterface(props: { attach: () => () => void }) {
  onCleanup(props.attach())

  return null
}
