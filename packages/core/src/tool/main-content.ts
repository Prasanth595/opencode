import { Parser } from "htmlparser2"

/** Opt-in HTML <main> extraction. Falls back to the original document on ambiguous markup. */
export const mainContent = (html: string) => {
  let start = -1
  let end = -1
  let depth = 0
  let count = 0
  const parser = new Parser({
    onopentag(name) {
      if (name !== "main") return
      count++
      if (count === 1) start = parser.startIndex
      depth++
    },
    onclosetag(name) {
      if (name !== "main" || depth === 0) return
      if (--depth === 0) end = parser.endIndex + 1
    },
  })
  parser.end(html)
  return count === 1 && start >= 0 && end > start ? html.slice(start, end) : html
}
