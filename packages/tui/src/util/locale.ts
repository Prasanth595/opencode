import { stringWidth } from "./string-width"

export function titlecase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function time(input: number): string {
  const date = new Date(input)
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export function datetime(input: number): string {
  const date = new Date(input)
  const localTime = time(input)
  const localDate = date.toLocaleDateString()
  return `${localTime} · ${localDate}`
}

export function number(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}

export function duration(input: number) {
  if (input < 1000) {
    return `${input}ms`
  }
  if (input < 60000) {
    return `${(input / 1000).toFixed(1)}s`
  }
  if (input < 3600000) {
    const minutes = Math.floor(input / 60000)
    const seconds = Math.floor((input % 60000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (input < 86400000) {
    const hours = Math.floor(input / 3600000)
    const minutes = Math.floor((input % 3600000) / 60000)
    return `${hours}h ${minutes}m`
  }
  const days = Math.floor(input / 86400000)
  const hours = Math.floor((input % 86400000) / 3600000)
  return `${days}d ${hours}h`
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function graphemes(str: string) {
  return Array.from(graphemeSegmenter.segment(str), (item) => item.segment)
}

function keepWithinWidth(segments: string[], width: number) {
  const kept: string[] = []
  let used = 0
  for (const segment of segments) {
    const next = stringWidth(segment)
    if (used + next > width) break
    kept.push(segment)
    used += next
  }
  return kept
}

export function takeWidth(str: string, width: number) {
  if (width <= 0) return ""
  if (stringWidth(str) <= width) return str
  return keepWithinWidth(graphemes(str), width).join("")
}

function takeWidthEnd(str: string, width: number) {
  if (width <= 0) return ""
  if (stringWidth(str) <= width) return str
  return keepWithinWidth(graphemes(str).reverse(), width).reverse().join("")
}

export function truncateWidth(str: string, width: number): string {
  if (width <= 0) return ""
  if (stringWidth(str) <= width) return str
  if (width === 1) return "…"
  return takeWidth(str, width - 1) + "…"
}

// Kept as an alias so callers that pass a column budget get display-width truncation.
export function truncate(str: string, len: number): string {
  return truncateWidth(str, len)
}

export function truncateLeft(str: string, len: number): string {
  if (stringWidth(str) <= len) return str
  if (len <= 0) return ""
  if (len === 1) return "…"
  return "…" + takeWidthEnd(str, len - 1)
}

export function truncateMiddle(str: string, maxLength: number = 35): string {
  if (stringWidth(str) <= maxLength) return str
  if (maxLength <= 0) return ""
  if (maxLength === 1) return "…"
  const keep = maxLength - 1
  return takeWidth(str, Math.ceil(keep / 2)) + "…" + takeWidthEnd(str, Math.floor(keep / 2))
}

export * as Locale from "./locale"
