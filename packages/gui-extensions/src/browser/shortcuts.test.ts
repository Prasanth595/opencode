import { afterEach, expect, setSystemTime, test } from "bun:test"
import { appShortcut, pageShortcut, type PageKey } from "./shortcuts"

afterEach(() => {
  setSystemTime()
})

/** A key press with `mod` as the platform's modifier: Command on macOS, Control elsewhere. */
const press = (modifiers: string, key: string, mac: boolean, code = ""): PageKey => {
  const held = modifiers.split("+")
  const mod = held.includes("mod")

  return {
    key,
    code,
    control: held.includes("ctrl") || (mod && !mac),
    meta: mod && mac,
    shift: held.includes("shift"),
    alt: held.includes("alt"),
  }
}

test("classifies reserved browser chords, page-first app chords and page-owned chords across platforms", () => {
  // [modifiers, Input.key, the key as the app's keybind names it, macOS, classification]. Every press is also
  // registered as an app keybind, so only the chord's class decides whether main claims it, lets the page try first,
  // or leaves it to the page.
  const cases: [
    modifiers: string,
    key: string,
    chord: string,
    mac: boolean,
    owner: "reserved" | "page" | undefined,
    code?: string,
  ][] = [
    // Reserved by main: browser tab and window chords a page cannot claim.
    ["mod", "t", "t", true, "reserved"],
    ["mod", "t", "t", false, "reserved"],
    ["mod", "w", "w", true, "reserved"],
    ["mod", "w", "w", false, "reserved"],
    ["mod", "n", "n", true, "reserved"],
    ["mod", "n", "n", false, "reserved"],
    ["mod", "1", "1", true, "reserved"],
    ["mod", "9", "9", false, "reserved"],
    ["mod+alt", "ArrowLeft", "arrowleft", true, "reserved"],
    ["mod+alt", "ArrowRight", "arrowright", false, "reserved"],
    ["ctrl", "Tab", "tab", true, "reserved"],
    ["ctrl+shift", "Tab", "tab", false, "reserved"],
    // Page-first app keybinds: the page gets the key first and keeps it when it calls preventDefault().
    ["mod+shift", "R", "r", true, "page"],
    ["mod+shift", "R", "r", false, "page"],
    ["mod", "k", "k", true, "page"],
    ["mod", "k", "k", false, "page"],
    ["mod", "p", "p", true, "page"],
    ["mod", "p", "p", false, "page"],
    ["mod", ",", "comma", true, "page"],
    ["mod", "\\", "\\", false, "page"],
    ["mod+shift", "L", "l", true, "page"],
    ["mod+shift", "E", "e", true, "page"],
    ["mod+shift", "T", "t", true, "page"],
    ["mod", "y", "y", true, "page"],
    ["mod+alt", "®", "r", true, "page", "KeyR"],
    ["ctrl", "`", "`", true, "page"],
    ["ctrl", "b", "b", false, "page"],
    ["ctrl+shift", "E", "e", false, "page"],
    // Clipboard, select all, undo and redo.
    ["mod", "c", "c", true, undefined],
    ["mod", "x", "x", true, undefined],
    ["mod", "v", "v", true, undefined],
    ["mod+shift", "V", "v", true, undefined],
    ["mod", "a", "a", true, undefined],
    ["mod", "z", "z", true, undefined],
    ["mod+shift", "Z", "z", true, undefined],
    ["mod", "c", "c", false, undefined],
    ["mod", "x", "x", false, undefined],
    ["mod", "v", "v", false, undefined],
    ["mod", "a", "a", false, undefined],
    ["mod", "z", "z", false, undefined],
    ["mod", "y", "y", false, undefined],
    ["mod+shift", "Z", "z", false, undefined],
    // Find, reload and history.
    ["mod", "f", "f", true, undefined],
    ["mod", "f", "f", false, undefined],
    ["mod", "g", "g", true, undefined],
    ["mod+shift", "G", "g", true, undefined],
    ["mod", "r", "r", true, undefined],
    ["mod", "r", "r", false, undefined],
    ["mod", "[", "[", true, undefined],
    ["mod", "]", "]", true, undefined],
    // The pane's own address, element picker and zoom keys.
    ["mod", "l", "l", true, undefined],
    ["mod", "l", "l", false, undefined],
    ["mod+shift", "C", "c", true, undefined],
    ["mod", "=", "=", true, undefined],
    ["mod+shift", "+", "plus", true, undefined],
    ["mod", "-", "-", true, undefined],
    ["mod", "0", "0", false, undefined],
    // Moving and selecting in a text field.
    ["mod", "ArrowLeft", "arrowleft", true, undefined],
    ["mod+shift", "ArrowRight", "arrowright", false, undefined],
    ["mod", "Backspace", "backspace", false, undefined],
    ["mod", "Delete", "delete", true, undefined],
    ["mod", "Home", "home", false, undefined],
    ["mod", "End", "end", true, undefined],
    // macOS moves the caret with Control and a letter.
    ["ctrl", "b", "b", true, undefined],
    ["ctrl+shift", "E", "e", true, undefined],
    // Typing, Alt characters and Tab.
    ["", "k", "k", true, undefined],
    ["shift", "K", "k", true, undefined],
    ["alt", "ArrowUp", "arrowup", true, undefined],
    ["alt", "ArrowUp", "arrowup", false, undefined],
    ["shift", "Tab", "tab", true, undefined],
  ]

  const results = cases.map(([modifiers, key, chord, mac, , code]) => {
    const input = press(modifiers, key, mac, code)
    const registered = { key: chord, ctrl: input.control, meta: input.meta, shift: input.shift, alt: input.alt }

    return [modifiers, key, mac, appShortcut(input, [registered], mac)]
  })

  expect(results).toEqual(cases.map(([modifiers, key, , mac, owner]) => [modifiers, key, mac, owner]))
})

test("a page keeps a chord the app binds with other modifiers or not at all", () => {
  const chords = [
    { key: "r", ctrl: false, meta: true, shift: true, alt: false },
    { key: "w", ctrl: false, meta: true, shift: false, alt: false },
  ]

  expect(appShortcut(press("mod+shift", "R", true), chords, true)).toBe("page")
  expect(appShortcut(press("mod", "w", true), chords, true)).toBe("reserved")
  expect(appShortcut(press("mod+shift", "R", false), chords, false)).toBeUndefined()
  expect(appShortcut(press("mod", "w", false), chords, false)).toBeUndefined()
  expect(appShortcut(press("mod+shift+alt", "‰", true, "KeyR"), chords, true)).toBeUndefined()
  expect(appShortcut(press("mod", "k", true), chords, true)).toBeUndefined()
  expect(appShortcut(press("mod+shift", "R", true), [], true)).toBeUndefined()
})

test("forwards a page-first shortcut only when the page did not preventDefault a recent matching keyDown", () => {
  setSystemTime(new Date("2026-10-18T12:00:00.000Z"))

  const chords = [
    { key: "k", ctrl: false, meta: true, shift: false, alt: false },
    { key: "w", ctrl: false, meta: true, shift: false, alt: false },
    { key: "c", ctrl: false, meta: true, shift: false, alt: false },
  ]

  const cmdK = press("mod", "k", true, "KeyK")
  const pending = { key: cmdK, at: Date.now() }
  const unhandled = JSON.stringify({ ...cmdK, defaultPrevented: false })
  const handled = JSON.stringify({ ...cmdK, defaultPrevented: true })

  expect(pageShortcut(unhandled, pending, chords, true)).toMatchObject(cmdK)
  expect(pageShortcut(handled, pending, chords, true)).toBeUndefined()
  expect(pageShortcut(unhandled, undefined, chords, true)).toBeUndefined()
  expect(
    pageShortcut(JSON.stringify({ ...press("mod+shift", "K", true), defaultPrevented: false }), pending, chords, true),
  ).toBeUndefined()

  const cmdW = press("mod", "w", true, "KeyW")
  expect(
    pageShortcut(JSON.stringify({ ...cmdW, defaultPrevented: false }), { key: cmdW, at: Date.now() }, chords, true),
  ).toBeUndefined()

  const cmdC = press("mod", "c", true, "KeyC")
  expect(
    pageShortcut(JSON.stringify({ ...cmdC, defaultPrevented: false }), { key: cmdC, at: Date.now() }, chords, true),
  ).toBeUndefined()

  setSystemTime(new Date("2026-10-18T12:00:01.001Z"))
  expect(pageShortcut(unhandled, pending, chords, true)).toBeUndefined()
})
