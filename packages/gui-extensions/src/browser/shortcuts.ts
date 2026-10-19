import { Option, Schema } from "effect"
import type { KeyChord } from "../sdk"

/** A key press the page received, with Electron's `Input` field names. */
export type PageKey = Pick<Electron.Input, "key" | "code" | "control" | "meta" | "shift" | "alt">

/** A page-first shortcut keydown seen in `before-input-event`, waiting to hear whether the page handled it. */
export type PendingShortcut = { readonly key: PageKey; readonly at: number }

const PageShortcutPayload = Schema.fromJsonString(
  Schema.Struct({
    key: Schema.String,
    code: Schema.String,
    control: Schema.Boolean,
    meta: Schema.Boolean,
    shift: Schema.Boolean,
    alt: Schema.Boolean,
    defaultPrevented: Schema.Boolean,
  }),
)

// Unshifted chords with the platform's modifier that the page answers: clipboard, select all, undo, find, reload,
// history, and the pane's own address shortcut.
const pageKeys = ["c", "x", "v", "a", "z", "f", "g", "r", "[", "]", "l"]

// Shifted ones: redo, find previous, paste without formatting, and the element picker.
const pageShiftKeys = ["z", "g", "v", "c"]

// Moving and selecting by word or line in a text field, and the zoom keys the pane answers.
const pageAnyKeys = [
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
  "backspace",
  "delete",
  "home",
  "end",
  "=",
  "plus",
  "-",
  "0",
]

// Keys a keybind names in words, since its syntax joins keys with "+" and lists chords with ",".
const keyNames = [
  [",", "comma"],
  ["+", "plus"],
  [" ", "space"],
]

/**
 * Classifies a key press in a focused page against the window's active app keybinds.
 *
 * - `"reserved"`: tab and window chords a browser never lets a page claim (⌘T, ⌘W, ⌘N, ⌘1–9, ⌘⌥←/→, and
 *   Ctrl+Tab / Ctrl+Shift+Tab). Main blocks these in `before-input-event` and forwards them immediately.
 * - `"page"`: every other registered app keybind that is not page-owned. The page receives the key first; main
 *   forwards it only if the page leaves `defaultPrevented` false.
 * - `undefined`: typing, Alt characters, Tab, unregistered chords, and the editing, find, reload, history and caret
 *   chords the page always keeps.
 *
 * @param mac - Whether the platform modifier is Command (macOS) rather than Control.
 */
export function appShortcut(
  input: PageKey,
  chords: readonly KeyChord[],
  mac: boolean,
): "reserved" | "page" | undefined {
  if (!input.control && !input.meta) return undefined
  const key = chordKey(input)

  if (pageOwned(key, input, mac)) return undefined

  const registered = chords.some(
    (chord) =>
      chord.key === key &&
      chord.ctrl === input.control &&
      chord.meta === input.meta &&
      chord.shift === input.shift &&
      chord.alt === input.alt,
  )

  if (!registered) return undefined

  return reserved(key, input, mac) ? "reserved" : "page"
}

/**
 * Validates the JSON payload the isolated-world listener reported after a page-first keydown. Returns the key to
 * forward when the page did not call `preventDefault()`, the event matches a `before-input-event` keyDown from the
 * last second, and the chord is still a page-first app keybind.
 *
 * @param mac - Whether the platform modifier is Command (macOS) rather than Control.
 */
export function pageShortcut(
  payload: string,
  pending: PendingShortcut | undefined,
  chords: readonly KeyChord[],
  mac: boolean,
): PageKey | undefined {
  if (!pending || Date.now() - pending.at > 1_000) return undefined
  const event = Option.getOrUndefined(Schema.decodeUnknownOption(PageShortcutPayload)(payload))

  if (!event || event.defaultPrevented) return undefined

  const same =
    chordKey(event) === chordKey(pending.key) &&
    event.control === pending.key.control &&
    event.meta === pending.key.meta &&
    event.shift === pending.key.shift &&
    event.alt === pending.key.alt

  return same && appShortcut(event, chords, mac) === "page" ? event : undefined
}

/**
 * Runs inside each frame's isolated world so page scripts cannot call `send`. For every trusted Ctrl or Cmd keydown,
 * appends a `{ once: true }` bubble listener on `target` (so it runs after bubble listeners the page already
 * registered) plus a `setTimeout(..., 0)` fallback for pages that call `stopPropagation()`, then reports whether
 * `event.defaultPrevented` was set.
 */
export function listenPageShortcuts(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  send: (payload: string) => void,
) {
  target.addEventListener(
    "keydown",
    (event) => {
      if (
        !event.isTrusted ||
        (!event.ctrlKey && !event.metaKey) ||
        ["Control", "Meta", "Shift", "Alt"].includes(event.key)
      )
        return
      let done = false

      const check = () => {
        if (done) return
        done = true
        target.removeEventListener("keydown", check)
        send(
          JSON.stringify({
            key: event.key,
            code: event.code,
            control: event.ctrlKey,
            meta: event.metaKey,
            shift: event.shiftKey,
            alt: event.altKey,
            defaultPrevented: event.defaultPrevented,
          }),
        )
      }

      target.addEventListener("keydown", check, { once: true })
      setTimeout(check, 0)
    },
    true,
  )
}

/** The key as the app names it in a keybind, as its keydown handler reads a KeyboardEvent. */
function chordKey(input: PageKey) {
  const key = keyNames.find((name) => name[0] === input.key)?.[1] ?? input.key.toLowerCase()

  if (!input.alt || /^[a-z0-9]$/.test(key)) return key

  if (!input.code.startsWith("Key") || input.code.length !== 4) return key

  return input.code.slice(3).toLowerCase()
}

// Chords a real browser reserves for tab and window management so a page cannot trap focus.
function reserved(key: string, input: PageKey, mac: boolean) {
  if (input.control && !input.meta && !input.alt && key === "tab") return true
  const mod = mac ? input.meta && !input.control : input.control && !input.meta

  if (!mod || input.shift) return false

  if (input.alt) return key === "arrowleft" || key === "arrowright"

  return /^([twn]|[1-9])$/.test(key)
}

function pageOwned(key: string, input: PageKey, mac: boolean) {
  // macOS text fields move and edit with Control and a letter, as in Emacs.
  if (mac && input.control && !input.meta && !input.alt && /^[a-z]$/.test(key)) return true
  const mod = mac ? input.meta && !input.control : input.control && !input.meta

  if (!mod || input.alt) return false

  if (pageAnyKeys.includes(key)) return true

  if (input.shift) return pageShiftKeys.includes(key)

  // Ctrl+Y redoes outside macOS.
  return pageKeys.includes(key) || (!mac && key === "y")
}
