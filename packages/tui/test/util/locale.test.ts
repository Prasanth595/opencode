import { expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

// Thai upper vowels and tone marks (U+0E31, U+0E34-U+0E3A, U+0E47-U+0E4E) are zero width and stay
// attached to their consonant, so a cut must never start the result with one.
const leadingMark = /^…?[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/

test("truncates text from the right by terminal width", () => {
  expect(Locale.truncateWidth("abcdefgh", 5)).toBe("abcd…")
  expect(Locale.truncateWidth("ab界cd", 5)).toBe("ab界…")
  expect(Locale.truncateWidth("abcdefgh", 1)).toBe("…")
  expect(Locale.truncateWidth("abcdefgh", 0)).toBe("")
})

test("takes whole graphemes within terminal width", () => {
  expect(Locale.takeWidth("ab界cd", 4)).toBe("ab界")
  expect(Locale.graphemes("a👨‍👩‍👧‍👦b")).toEqual(["a", "👨‍👩‍👧‍👦", "b"])
})

test("truncate counts display width instead of UTF-16 units", () => {
  expect(Locale.truncate("hello", 5)).toBe("hello")
  expect(Locale.truncate("พลัง", 3)).toBe("พลัง")
  expect(Locale.truncate("กำลังทดสอบ", 5)).toBe("กำลัง…")
  expect(Locale.truncate("こんにちは", 5)).toBe("こん…")
})

test("truncate keeps grapheme clusters whole", () => {
  expect(Locale.truncate("👨‍👩‍👧‍👦abc", 3)).toBe("👨‍👩‍👧‍👦…")
  expect(Locale.truncate("สวัสดีครับ", 3)).toBe("สวั…")
  expect(Locale.truncate("กำลังทดสอบ", 3)).toBe("กำ…")
})

test("truncateLeft does not leave a dangling combining mark", () => {
  expect(Locale.truncateLeft("พลัง", 3)).toBe("พลัง")
  expect(Locale.truncateLeft("กำลังทดสอบ", 8)).toBe("…ลังทดสอบ")
  expect(Locale.truncateLeft("สวัสดีครับ", 4)).toBe("…ครับ")
  expect(Locale.truncateLeft("กำลังทดสอบไทย", 5)).not.toMatch(leadingMark)
})

test("truncateMiddle keeps graphemes whole at both ends", () => {
  expect(Locale.truncateMiddle("สวัสดีครับ", 20)).toBe("สวัสดีครับ")
  expect(Locale.truncateMiddle("กำลังทดสอบไทย", 6)).toBe("กำลั…ทย")
  expect(Locale.truncateMiddle("abcdefghij", 5)).toBe("ab…ij")
})
