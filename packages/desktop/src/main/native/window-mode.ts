export type WindowModeCommand = "enter-fullscreen" | "leave-fullscreen" | "maximize" | "restore"

/**
 * Decide what the "Toggle Full Screen" menu item should do.
 *
 * On Windows, native fullscreen covers the taskbar while the app's own titlebar and menu stay
 * visible, leaving users with the worst of both worlds (issue #54714). Toggle maximize instead
 * so the taskbar stays reachable. macOS and other platforms keep native fullscreen.
 */
export function toggleWindowMode(
  platform: NodeJS.Platform,
  state: { fullscreen: boolean; maximized: boolean },
): WindowModeCommand {
  if (platform !== "win32") return state.fullscreen ? "leave-fullscreen" : "enter-fullscreen"

  if (state.fullscreen) return "leave-fullscreen"

  return state.maximized ? "restore" : "maximize"
}
