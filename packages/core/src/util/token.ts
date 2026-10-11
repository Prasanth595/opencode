export * as Token from "./token.js"

const CHARS_PER_TOKEN = 4

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

/** The number of characters `estimate` counts as this many tokens. */
export const chars = (tokens: number) => tokens * CHARS_PER_TOKEN
