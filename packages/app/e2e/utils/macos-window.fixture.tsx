import { MemoryRouter, createMemoryHistory } from "@solidjs/router"
import { render } from "solid-js/web"
import type { Bridge } from "@opencode/gui-extensions/sdk/bridge"
import { AppBaseProviders, AppInterface } from "../../src/app"
import { PlatformProvider, type Platform } from "../../src/runtime/platform/platform"

// The app in a macOS desktop window at `route`, so its layout leaves room for the native traffic lights. A fullscreen
// window has none.
export function mount(input: { server: string; route: string; fullscreen: boolean }) {
  const root = document.getElementById("root")

  if (!root) throw new Error("Missing fixture root")
  const history = createMemoryHistory()
  history.set({ value: input.route })
  render(() => {
    const unused = async () => {
      throw new Error("Unexpected fixture action")
    }

    // No main-process extensions run in this fixture.
    const bridge: Bridge = {
      packaged: false,
      call: unused,
      subscribe: async () => ({ available: false }),
      on: () => () => undefined,
      embed: () => undefined,
      capture: async () => undefined,
      runMenubarItem: () => undefined,
      configure: () => undefined,
      manager: {
        list: async () => [],
        enable: async () => undefined,
        disable: async () => undefined,
        reload: async () => undefined,
        install: async () => undefined,
        remove: async () => undefined,
        source: async () => "",
        asset: () => "",
      },
    }

    const platform: Platform = {
      platform: "desktop",
      os: "macos",
      windowID: "macos-window-test",
      windowFullscreen: () => input.fullscreen,
      openExternal: () => undefined,
      openDirectoryPickerDialog: async () => null,
      notify: async () => undefined,
      restart: unused,
      extensions: bridge,
    }

    return (
      <PlatformProvider value={platform}>
        <AppBaseProviders locale="en">
          <AppInterface
            servers={[{ type: "http", displayName: "Local Server", http: { url: input.server } }]}
            router={(props) => <MemoryRouter {...props} history={history} />}
          />
        </AppBaseProviders>
      </PlatformProvider>
    )
  }, root)
}
