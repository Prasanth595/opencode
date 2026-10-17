import { describe, expect, test } from "bun:test"
import { DESKTOP_NATIVE_LOCALES } from "./desktop-native"
import en from "./en"

// A locale that drops a placeholder, or that keeps a key English no longer has, still parses
// and still renders: every key it does not translate falls back to English. Nothing fails
// until a native speaker reports the broken sentence, so these tests catch the drift here.

// CLDR plural categories other than `one` and `other` only exist in the locales whose
// language needs them, so keys are compared by plural family: `settings.count.few` is the
// same string as `settings.count.one`.
const PLURAL_CATEGORY = /\.(zero|one|two|few|many|other)$/

// The least complete locale on dev translates about 85% of the English dictionary, so this
// floor leaves room for English gaining keys and only trips when a locale loses a large
// batch of translations.
const MINIMUM_COVERAGE = 0.8

const locales = DESKTOP_NATIVE_LOCALES.filter((locale) => locale !== "en")

const dictionaries = await Promise.all(locales.map(async (locale) => [locale, await load(locale)] as const))

const english: Record<string, string> = en

const englishKeys = new Set(Object.keys(english))

const englishFamilies = new Set([...englishKeys].map(family))

describe("app locale parity", () => {
  test("every locale keeps the placeholders English defines", () => {
    const drift = dictionaries.flatMap(([locale, dictionary]) => placeholderDrift(locale, dictionary))

    expect(drift).toEqual([])
  })

  test("no locale defines a key English does not", () => {
    const unknown = dictionaries.flatMap(([locale, dictionary]) => unknownKeys(locale, dictionary))

    expect(unknown).toEqual([])
  })

  test("every locale keeps most of the English dictionary", () => {
    const thin = dictionaries
      .map(([locale, dictionary]) => [locale, Object.keys(dictionary).length] as const)
      .filter(([, count]) => count / englishKeys.size < MINIMUM_COVERAGE)
      .map(([locale, count]) => `${locale} ${Math.round((count / englishKeys.size) * 100)}%`)

    expect(thin).toEqual([])
  })

  test("zh and zht translate the same keys", () => {
    const simplified = Object.keys(dictionary("zh"))
    const traditional = Object.keys(dictionary("zht"))

    expect(simplified.filter((key) => !traditional.includes(key))).toEqual([])
    expect(traditional.filter((key) => !simplified.includes(key))).toEqual([])
  })
})

function family(key: string) {
  return key.replace(PLURAL_CATEGORY, "")
}

function placeholders(value: string) {
  return new Set([...value.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((match) => match[1]))
}

async function load(locale: string) {
  const module = await import(`./${locale}.ts`)

  // SAFETY: every locale module in this directory exports a string dictionary.
  return module.dict as Record<string, string>
}

function placeholderDrift(locale: string, dictionary: Record<string, string>) {
  const drift: string[] = []

  for (const [key, value] of Object.entries(dictionary)) {
    if (!englishKeys.has(key)) continue

    const expected = placeholders(english[key])

    const actual = placeholders(value)

    const missing = [...expected].filter((placeholder) => !actual.has(placeholder))

    const added = [...actual].filter((placeholder) => !expected.has(placeholder))

    if (missing.length || added.length)
      drift.push(`${locale}/${key} missing=${missing.join(",")} added=${added.join(",")}`)
  }

  return drift
}

function unknownKeys(locale: string, dictionary: Record<string, string>) {
  return Object.keys(dictionary)
    .filter((key) => !englishKeys.has(key) && !englishFamilies.has(family(key)))
    .map((key) => `${locale}/${key}`)
}

function dictionary(locale: string) {
  const entry = dictionaries.find(([name]) => name === locale)

  if (!entry) throw new Error(`locale ${locale} is registered but has no dictionary`)

  return entry[1]
}
