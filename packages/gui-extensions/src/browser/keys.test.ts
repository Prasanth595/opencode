import { expect, test } from "bun:test"
import { pageLetter } from "./keys"

test.each([
  { layout: "QWERTY", input: { key: "C", code: "KeyC" }, letter: "c" },
  // Dvorak types C on the physical I key; Chromium reports the physical key as the code.
  { layout: "Dvorak", input: { key: "C", code: "KeyI" }, letter: "c" },
  { layout: "Dvorak", input: { key: "l", code: "KeyP" }, letter: "l" },
  // Dvorak's J sits where QWERTY has C, so it must not open the picker.
  { layout: "Dvorak", input: { key: "J", code: "KeyC" }, letter: "j" },
  { layout: "Russian", input: { key: "\u0421", code: "KeyC" }, letter: "c" },
  { layout: "QWERTY", input: { key: "=", code: "Equal" }, letter: "=" },
])("$layout $input.key on $input.code is $letter", (row) => {
  expect(pageLetter(row.input)).toBe(row.letter)
})
