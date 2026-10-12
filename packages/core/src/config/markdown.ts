export * as ConfigMarkdown from "./markdown.js"

import matter from "gray-matter"
export function parse(content: string) {
  // Passing options bypasses gray-matter's module-global content cache, which
  // it populates before parsing: a failed YAML parse poisons the entry and
  // every later parse of the same content replays it without throwing, so the
  // sanitize fallback below never runs. Upstream: jonschlinkert/gray-matter#166.
  try {
    return matter(content, {})
  } catch {
    return matter(sanitize(content), {})
  }
}

export function parseOption(content: string) {
  try {
    return parse(content)
  } catch {
    return undefined
  }
}

// Other coding agents accept unquoted colons in frontmatter values. Retry
// those values as YAML block scalars so existing config files keep working.
export function sanitize(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const lines = frontmatter.split(/\r?\n/)
  const result = lines.flatMap((line, index) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    // Anchors (&), aliases (*) and tags (!) are structural YAML: rewriting such
    // a line to a block scalar would detach the anchor and break every later
    // `*alias` reference. Leave them exactly as written.
    if (/^[&*!]/.test(value)) return [line]
    // A plain scalar beginning with a flow indicator ([ or {) is read as a
    // flow collection. When it is not valid flow syntax (e.g.
    // `description: [Team] Does a thing`) the whole frontmatter block fails to
    // parse and the document is dropped silently. Quote such a value so it is
    // kept as written, but judge it with the surrounding lines so multiline
    // blocks and anchors keep their context; leave everything alone when the
    // block already parses (a real flow collection must keep its type).
    if (value.startsWith("[") || value.startsWith("{")) {
      if (parseable(frontmatter)) return [line]
      const quoted = `${entry[1]}: ${JSON.stringify(value)}`
      const candidate = lines.map((item, i) => (i === index ? quoted : item)).join("\n")
      return parseable(candidate) ? [quoted] : [line]
    }
    if (!value.includes(":")) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}

function parseable(frontmatter: string): boolean {
  try {
    matter(`---\n${frontmatter}\n---\n`, {})
    return true
  } catch {
    return false
  }
}
