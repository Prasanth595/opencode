/**
 * Host-internal contract between the renderer host (packages/app) and the main host (packages/desktop).
 * Extensions never use this directly; they use Ipc tokens.
 * Payloads are structured-clone values already encoded with the Ipc's schemas. The `ipc` fields name an Ipc by id.
 */

import type { Definition } from "./core"

/** One explicit desktop enable-state row. An absent row means there is no setting under that id. */
export interface EnableState {
  /** The extension id the user saved a setting under, including ids from before a rename. */
  readonly id: string
  /** The saved setting: true enables the extension; false disables it. */
  readonly enabled: boolean
}

/**
 * Resolves desktop enable state without changing stored rows. The current id wins, then legacy ids newest first;
 * no matching row means enabled. Both hosts use this rule, including a window's preload snapshot.
 *
 * @param definition - The current id and its optional earlier ids.
 * @param state - Explicit saved rows, or the manager's resolved list.
 * @returns Whether the extension is enabled.
 */
export function extensionEnabled(definition: Pick<Definition, "id" | "legacy">, state: readonly EnableState[]) {
  const row = [definition.id, ...(definition.legacy ?? [])]
    .map((id) => state.find((item) => item.id === id))
    .find((item) => item !== undefined)

  return row?.enabled ?? true
}

/**
 * A placeholder for a module that exists only in the other process, so one plugin `./gui` bundle runs in both: a window
 * gets one for `electron` and Node built-ins, main gets one for Solid and the window-only modules. Bundlers hoist
 * `require` calls and Solid hoists template creation to module scope, so the placeholder accepts any property read,
 * call or construction and returns itself. It is never a thenable, so a promise never waits on it. Code that actually
 * runs in the wrong process gets placeholders back instead of working values; keep each process's code in its entry.
 *
 * @param name - The module's name, shown when the placeholder is converted to a string.
 * @returns The placeholder.
 */
export function inertModule(name: string): InertModule {
  const label = `[inert module ${name}]`

  const handler: ProxyHandler<InertModule> = {
    get(_, key) {
      if (key === "then") return undefined

      if (key === Symbol.toPrimitive || key === "toString") return () => label

      return placeholder
    },
    apply: () => placeholder,
    construct: () => placeholder,
  }

  const placeholder = new Proxy(inertTarget, handler)

  return placeholder
}

/** The function every inert module placeholder wraps, so the placeholder can be called and constructed. */
function inertTarget() {}

/** A placeholder `inertModule` returns: it answers every property read, call and construction with itself. */
export type InertModule = typeof inertTarget

/** Where an embed sits in its window, as the renderer measured it. */
export interface BridgeLayout {
  /** The embed should be on screen. */
  readonly visible: boolean
  /** Its box in window pixels; absent while it is not laid out. */
  readonly bounds?: {
    /** Left edge. */
    readonly x: number
    /** Top edge. */
    readonly y: number
    /** Width. */
    readonly width: number
    /** Height. */
    readonly height: number
  }
  /** The window's content size the bounds were measured against. */
  readonly viewport?: {
    /** Content width in window pixels. */
    readonly width: number
    /** Content height in window pixels. */
    readonly height: number
  }
  /** RGBA of the backdrop the rounded corners show. */
  readonly background?: readonly [number, number, number, number]
  /** Radius of the bottom corners. */
  readonly radius?: number
  /** The rounded card's hairline ring, which the corner masks would otherwise paint over. */
  readonly border?: {
    /** RGBA of the ring. */
    readonly color: readonly [number, number, number, number]
    /** Ring width in window pixels. */
    readonly width: number
  }
}

/** An extension as the extension manager lists it. */
export interface Installed {
  /** The extension's id. */
  readonly id: string
  /** Its display name. */
  readonly name: string
  /** Its version; the app's version for built-ins. */
  readonly version: string
  /** Ships with the app. */
  readonly builtin: boolean
  /** The user has it enabled. */
  readonly enabled: boolean
  /** Changes when the extension is replaced or reloaded. */
  readonly revision?: string
  /** Why its main entry failed, if it did. */
  readonly error?: string
  /** Comes from an OpenCode plugin package's `./gui` export on the local server, not a built-in. */
  readonly plugin?: boolean
}

/** A local-server plugin that ships a GUI extension, as a window reports it to main. */
export interface BridgePlugin {
  /** The plugin's id, which is also its GUI extension's id. */
  readonly id: string
  /** Changes whenever the plugin is replaced or reloaded. */
  readonly revision: string
  /** The plugin's `./gui` bundle exports `main`, a setup main runs after it reads the bundle from the local server. */
  readonly main: boolean
}

/**
 * A message main pushes to a window.
 * - `state`: an Ipc's new state for this window.
 * - `event`: an Ipc event.
 * - `available`: an Ipc's provider came or went.
 * - `extensions`: the installed list changed.
 * - `menubarItems`: the native menu's extension items changed.
 */
export type BridgeMessage =
  | {
      /** An Ipc's new state. */
      readonly type: "state"
      /** The Ipc's id. */
      readonly ipc: string
      /** The encoded state. */
      readonly state: unknown
    }
  | {
      /** An Ipc event. */
      readonly type: "event"
      /** The Ipc's id. */
      readonly ipc: string
      /** The event's name. */
      readonly name: string
      /** The encoded data. */
      readonly data: unknown
    }
  | {
      /** An Ipc's provider came or went. */
      readonly type: "available"
      /** The Ipc's id. */
      readonly ipc: string
      /** It is provided now. */
      readonly available: boolean
    }
  | {
      /** The installed list changed. */
      readonly type: "extensions"
      /** The new list. */
      readonly list: readonly Installed[]
    }
  | {
      /** The native menu's extension items changed. */
      readonly type: "menubarItems"
      /** The new items. */
      readonly items: readonly BridgeMenubarItem[]
    }

/** A `MenubarItem` as main publishes it to windows that draw their own menu. */
export interface BridgeMenubarItem {
  /** The menu it goes in. */
  readonly menu: string
  /** `${extension}.${id}`. */
  readonly id: string
  /** The label. */
  readonly label: string
  /** The item it follows. */
  readonly after?: string
  /** The item is enabled now. */
  readonly enabled: boolean
}

/** What the desktop preload exposes to the renderer host; undefined on the web. */
export interface Bridge {
  /** The app runs packaged, as main's `Build.packaged` says; the window's `Build` reports the same. */
  readonly packaged: boolean
  /**
   * Calls an Ipc method.
   *
   * @param input - The Ipc, the method and the encoded input.
   * @param signal - Aborts the call.
   * @returns The encoded output.
   */
  // SAFETY: the reply is the method's output as its schema encoded it; the renderer host decodes it with that schema.
  /* oxlint-disable anti-slop/no-unknown-returns -- see SAFETY above */
  call(
    input: {
      /** The Ipc's id. */
      readonly ipc: string
      /** The method's name. */
      readonly method: string
      /** The encoded input. */
      readonly input: unknown
    },
    signal?: AbortSignal,
  ): Promise<unknown>
  /* oxlint-enable anti-slop/no-unknown-returns */
  /**
   * Starts state sync for this window. Resolves with the current availability and state.
   *
   * @param ipc - The Ipc's id.
   */
  subscribe(ipc: string): Promise<{
    /** The Ipc is provided. */
    readonly available: boolean
    /** Its encoded state for this window. */
    readonly state?: unknown
  }>
  /**
   * Listens to every message main pushes.
   *
   * @param listener - Receives each message.
   * @returns Removes the listener.
   */
  on(listener: (message: BridgeMessage) => void): () => void
  /**
   * Lays out an embed, or hides it without a layout.
   *
   * @param id - The embed's id.
   * @param layout - Where it goes.
   */
  embed(id: string, layout?: BridgeLayout): void
  /**
   * A JPEG still of an embed.
   *
   * @param id - The embed's id.
   */
  capture(id: string): Promise<Uint8Array | undefined>
  /**
   * Runs a native menubar item from the in-app (Windows) menu.
   *
   * @param id - `${extension}.${id}`.
   */
  runMenubarItem(id: string): void
  /**
   * Tells main the current server endpoints so `ServerEndpoints.get(id)` can resolve them.
   *
   * @param servers - The window's servers.
   */
  configure(
    servers: readonly {
      /** The server's id. */
      readonly id: string
      /** Its base URL. */
      readonly url: string
      /** The HTTP basic user name. */
      readonly username?: string
      /** The HTTP basic password. */
      readonly password?: string
    }[],
  ): void
  /**
   * Tells main which local-server plugins ship GUI extensions. Main reads each plugin's `./gui` bundle from the local
   * server itself, never from the window, and lists every plugin so the manager can enable and disable it. Undefined
   * where main does not host plugin entries.
   *
   * @param plugins - The plugins the window found on the local server.
   */
  readonly plugins?: (plugins: readonly BridgePlugin[]) => void
  /** The extension manager. */
  readonly manager: {
    /**
     * Explicit enable-state rows from the existing preload startup reply, including earlier ids. Undefined (or an
     * omitted promise) means unknown: activation waits for `list()` or a live list, never assumes all are enabled.
     * An empty list is authoritative: no saved settings. A rejected promise also falls back to the manager list.
     */
    readonly initial?: Promise<readonly EnableState[] | undefined>
    /** The installed extensions, built-ins included. */
    list(): Promise<readonly Installed[]>
    /**
     * Enables an extension.
     *
     * @param id - The extension's id.
     */
    enable(id: string): Promise<void>
    /**
     * Disables an extension.
     *
     * @param id - The extension's id.
     */
    disable(id: string): Promise<void>
    /**
     * Reloads an extension's main entry; a failed reload keeps the last good revision.
     *
     * @param id - The extension's id.
     */
    reload(id: string): Promise<void>
  }
}
