/**
 * The letter a page key press names, as the app's keybinds read it: the layout's character, so Dvorak's C is "c"
 * although it sits on the physical I key. A layout that types no Latin letter falls back to the physical key.
 */
export function pageLetter(input: Pick<Electron.Input, "key" | "code">) {
  const key = input.key.toLowerCase()

  if (/^[a-z]$/.test(key) || !/^Key[A-Z]$/.test(input.code)) return key

  return input.code.slice(3).toLowerCase()
}
