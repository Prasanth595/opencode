import * as fs from "node:fs"
import type { CliRenderer } from "@opentui/core"

type Renderer = Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">

// Restore the terminal modes the TUI turns on, and nothing else. Every sequence
// here is idempotent, so this is safe to run from more than one teardown path and
// never discards output that was already written (the exit epilogue).
//
// We deliberately do not emit `\x1b[?1049l`. Leaving the alternate screen races
// with process teardown on Windows ConPTY and can take down the parent shell or
// multiplexer pane; see https://github.com/anomalyco/opencode/issues/48776.
const RESTORE = [
  "\x1b[0m",
  "\x1b[?25h",
  "\x1b[?1l",
  "\x1b[?1000l",
  "\x1b[?1002l",
  "\x1b[?1003l",
  "\x1b[?1004l",
  "\x1b[?1005l",
  "\x1b[?1006l",
  "\x1b[?1015l",
  "\x1b[?2026l",
  "\x1b[?9001l",
  "\x1b[?2004l",
  "\x1b[<u",
].join("")

function write(sequence: string) {
  if (!process.stdout.isTTY) return
  fs.writeSync(1, Buffer.from(sequence, "utf8"))
}

/**
 * Put the terminal back the way we found it.
 *
 * Writes synchronously because the process may be on its way out and there is no
 * guarantee an async write would ever be flushed.
 */
export function restore() {
  write(RESTORE)
}

/**
 * Restore the terminal when the TUI dies without reaching `destroy`.
 *
 * `exit` covers normal exits, `process.exit()` and uncaught errors. SIGTERM has to
 * re-raise the default behaviour, otherwise registering a listener would stop the
 * process from ever terminating.
 */
export function install() {
  const onExit = () => restore()
  const onTerm = () => {
    restore()
    process.exit(143)
  }
  process.on("exit", onExit)
  process.on("SIGTERM", onTerm)
  return () => {
    process.off("exit", onExit)
    process.off("SIGTERM", onTerm)
  }
}

/**
 * Destroy the renderer and leave a clean terminal behind.
 *
 * On Windows the native renderer teardown is skipped: @opentui hands the terminal
 * back to the OS from inside process teardown, which on ConPTY stacks leaves the
 * shared console unable to restore itself and takes down the parent shell. The
 * native handle is released when the process exits anyway, so we restore the modes
 * ourselves instead.
 */
export function destroy(renderer: Renderer) {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return
  if (process.platform === "win32") detach(renderer)
  renderer.destroy()
  // Clear after destroying: the TUI has painted over the screen, and anything
  // printed afterwards (the exit epilogue) must survive.
  write("\x1b[2J\x1b[H")
  restore()
}

function detach(renderer: Renderer) {
  // `lib` is private on CliRenderer, but it is the only handle to the native
  // teardown and nothing seals the instance at runtime.
  const lib = (renderer as unknown as { lib?: Record<string, unknown> }).lib
  if (!lib) return
  if (typeof lib.destroyRenderer !== "function") return
  lib.destroyRenderer = () => {}
}
