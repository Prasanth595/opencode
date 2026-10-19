import type { InlineNode } from "./types"

export interface ReferenceDef {
  href: string
  title?: string
  raw?: string
}

export interface InlineParseOptions {
  gfm?: boolean
  math?: boolean
  streaming?: boolean
  heal?: boolean
  defs?: ReadonlyMap<string, ReferenceDef>
  onUnresolvedRef?: (refId: string) => void
  onUsedRef?: (refId: string) => void
}

const FILE_PATH_RE =
  /^(?:\.{0,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.[a-zA-Z0-9]{1,10}(?::\d+(?:-\d+)?)?$|^[A-Za-z0-9_.-]+\.(?:swift|ts|tsx|js|jsx|rs|py|go|md|json|yml|yaml|toml|sh|css|html)(?::\d+(?:-\d+)?)?$/

const URL_RE = /^https?:\/\/[^\s<>()`"']+$/

/**
 * Repairs incomplete inline markers at the tail of an actively streaming block
 * without touching closed spans or scanning settled blocks.
 */
export function healStreamingInline(raw: string): string {
  if (!raw) return raw

  // 1. Strip incomplete trailing link destination `[label](https://...` -> `label`
  let text = raw
  const lastOpenBracket = text.lastIndexOf("[")

  if (lastOpenBracket >= 0 && (lastOpenBracket === 0 || text[lastOpenBracket - 1] !== "\\")) {
    const after = text.slice(lastOpenBracket)
    const midMatch = /^(!?)\[([^\]]+)\]\(([^)\n]*)$/.exec(after)

    if (midMatch) {
      text = text.slice(0, lastOpenBracket) + (midMatch[1] ? "" : midMatch[2]!)
    }
  }

  // 2. Scan active backticks, math spans, bold, italic, and strikethrough
  let inCodeTicks = 0
  let boldAsterisk = false
  let emAsterisk = false
  let strikeTilde = false
  let wordHadEm = false

  const n = text.length
  let i = 0

  while (i < n) {
    const ch = text.charCodeAt(i)

    if (ch === 0x5c /* \ */) {
      if (inCodeTicks === 0 && i + 1 < n) {
        const nextEsc = text.charCodeAt(i + 1)

        if (nextEsc === 0x28 /* ( */) {
          const closeMath = text.indexOf("\\)", i + 2)

          if (closeMath > i + 2) {
            i = closeMath + 2
            continue
          }
        } else if (nextEsc === 0x5b /* [ */) {
          const closeMath = text.indexOf("\\]", i + 2)

          if (closeMath > i + 2) {
            i = closeMath + 2
            continue
          }
        }
      }

      i += 2
      continue
    }

    if (ch === 0x60 /* ` */) {
      let run = 1
      while (i + run < n && text.charCodeAt(i + run) === 0x60) run++

      if (inCodeTicks === 0) {
        inCodeTicks = run
      } else if (inCodeTicks === run) {
        inCodeTicks = 0
      }

      i += run
      continue
    }

    if (inCodeTicks > 0) {
      i++
      continue
    }

    if (isWhitespace(ch)) {
      wordHadEm = false
      i++
      continue
    }

    if (ch === 0x24 /* $ */) {
      if (i + 1 < n && text.charCodeAt(i + 1) === 0x24) {
        const close = findClosingDoubleDollar(text, i + 2)

        if (close > i + 2) {
          i = close + 2
          continue
        }

        i += 2
        continue
      }

      const close = findClosingDollar(text, i + 1)

      if (close > i + 1) {
        i = close + 1
        continue
      }

      i++
      continue
    }

    if (ch === 0x2a /* * */) {
      let run = 1
      while (i + run < n && text.charCodeAt(i + run) === 0x2a) run++

      if (run >= 3) {
        boldAsterisk = !boldAsterisk
        emAsterisk = !emAsterisk
        wordHadEm = true
      } else if (run === 2) {
        boldAsterisk = !boldAsterisk
        wordHadEm = true
      } else {
        const prev = i > 0 ? text.charCodeAt(i - 1) : 0x20
        const next = i + 1 < n ? text.charCodeAt(i + 1) : 0

        if (!emAsterisk) {
          if (next !== 0x20 && next !== 0x09 && next !== 0x0a && next !== 0 && (!isWordChar(prev) || wordHadEm)) {
            emAsterisk = true
            wordHadEm = true
          }
        } else {
          if (prev !== 0x20 && prev !== 0x09 && prev !== 0x0a) {
            emAsterisk = false
          }
        }
      }

      i += run
      continue
    }

    if (ch === 0x7e /* ~ */ && i + 1 < n && text.charCodeAt(i + 1) === 0x7e) {
      strikeTilde = !strikeTilde
      i += 2
      continue
    }

    i++
  }

  let suffix = ""

  if (inCodeTicks > 0) {
    suffix += "`".repeat(inCodeTicks)
  } else {
    if (strikeTilde) suffix += "~~"
    if (emAsterisk) suffix += "*"
    if (boldAsterisk) suffix += "**"
  }

  return suffix ? text + suffix : text
}

function isWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  )
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

function findClosingCodeTicks(src: string, from: number, count: number): number {
  const n = src.length
  let i = from

  while (i < n) {
    if (src.charCodeAt(i) === 0x60) {
      let run = 1
      while (i + run < n && src.charCodeAt(i + run) === 0x60) run++

      if (run === count) return i
      i += run
    } else {
      i++
    }
  }

  return -1
}

function findClosingDollar(src: string, from: number): number {
  const n = src.length

  if (from >= n) return -1
  const first = src.charCodeAt(from)

  if (isWhitespace(first) || first === 0x24 /* $ */) return -1

  let i = from

  while (i < n) {
    const c = src.charCodeAt(i)

    if (c === 0x5c /* \ */) {
      i += 2
      continue
    }

    if (c === 0x0a || c === 0x0d) return -1

    if (c === 0x24 /* $ */) {
      const prev = src.charCodeAt(i - 1)

      if (isWhitespace(prev)) return -1
      const next = i + 1 < n ? src.charCodeAt(i + 1) : 0

      // Pandoc currency rule: closing $ cannot be followed by alphanumeric/digit/underscore
      if (isWordChar(next)) return -1

      return i
    }

    i++
  }

  return -1
}

function findClosingDoubleDollar(src: string, from: number): number {
  const n = src.length
  let i = from

  while (i + 1 < n) {
    const c = src.charCodeAt(i)

    if (c === 0x5c /* \ */) {
      i += 2
      continue
    }

    if (c === 0x24 && src.charCodeAt(i + 1) === 0x24) {
      return i
    }

    i++
  }

  return -1
}

export function parseInlines(raw: string, options: InlineParseOptions = {}): InlineNode[] {
  const src = options.streaming && options.heal !== false ? healStreamingInline(raw) : raw

  if (!src) return []

  // Fast path for plain ASCII/Unicode text with zero inline punctuation triggers
  let hasSpecial = false

  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i)

    if (
      c === 0x60 /* ` */ ||
      c === 0x2a /* * */ ||
      c === 0x5f /* _ */ ||
      c === 0x7e /* ~ */ ||
      c === 0x5b /* [ */ ||
      c === 0x21 /* ! */ ||
      c === 0x24 /* $ */ ||
      c === 0x5c /* \ */ ||
      c === 0x3c /* < */ ||
      c === 0x0a /* \n */ ||
      (c === 0x68 /* h */ && src.startsWith("http", i))
    ) {
      hasSpecial = true
      break
    }
  }

  if (!hasSpecial) {
    return [{ type: "text", text: src }]
  }

  return tokenizeInlineRange(src, options)
}

function appendText(nodes: InlineNode[], text: string) {
  if (!text) return
  const last = nodes[nodes.length - 1]

  if (last && last.type === "text") {
    last.text += text
  } else {
    nodes.push({ type: "text", text })
  }
}

function tokenizeInlineRange(src: string, options: InlineParseOptions): InlineNode[] {
  const nodes: InlineNode[] = []
  const n = src.length
  const mathEnabled = options.math !== false
  const gfmEnabled = options.gfm !== false
  let i = 0
  let textStart = 0

  const flushText = (end: number) => {
    if (end > textStart) {
      appendText(nodes, src.slice(textStart, end))
    }
  }

  while (i < n) {
    const c = src.charCodeAt(i)

    // 1. Escape or `\( ... \)` inline math
    if (c === 0x5c /* \ */ && i + 1 < n) {
      const next = src.charCodeAt(i + 1)

      if (mathEnabled && next === 0x28 /* ( */) {
        const close = src.indexOf("\\)", i + 2)

        if (close > i + 2) {
          const mathText = src.slice(i + 2, close).trim()

          if (mathText.length > 0) {
            flushText(i)
            nodes.push({ type: "math", source: mathText, delimiter: "paren", display: false })
            i = close + 2
            textStart = i
            continue
          }
        }
      }

      if ("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".includes(src[i + 1]!)) {
        flushText(i)
        appendText(nodes, src[i + 1]!)
        i += 2
        textStart = i
        continue
      }

      i += 2
      continue
    }

    // 2. Hard line break (`  \n`)
    if (c === 0x0a /* \n */) {
      if (i >= 2 && src.charCodeAt(i - 1) === 0x20 && src.charCodeAt(i - 2) === 0x20) {
        flushText(i - 2)
        nodes.push({ type: "br" })
        i++
        textStart = i
        continue
      }

      i++
      continue
    }

    // 3. Inline code span `` `...` ``
    if (c === 0x60 /* ` */) {
      let run = 1
      while (i + run < n && src.charCodeAt(i + run) === 0x60) run++
      const close = findClosingCodeTicks(src, i + run, run)

      if (close >= 0) {
        flushText(i)
        let codeText = src.slice(i + run, close)

        if (
          codeText.length >= 2 &&
          codeText.charCodeAt(0) === 0x20 &&
          codeText.charCodeAt(codeText.length - 1) === 0x20 &&
          codeText.trim().length > 0
        ) {
          codeText = codeText.slice(1, -1)
        }

        const isUrl = URL_RE.test(codeText)
        const isFilePath = !isUrl && FILE_PATH_RE.test(codeText)
        const codeNode: Extract<InlineNode, { type: "code" }> = {
          type: "code",
          text: codeText,
        }

        if (isUrl) codeNode.isUrl = true
        if (isFilePath) codeNode.isFilePath = true
        nodes.push(codeNode)
        i = close + run
        textStart = i
        continue
      }

      i += run
      continue
    }

    // 4. Inline math `$...$` or `$$...$$`
    if (mathEnabled && c === 0x24 /* $ */) {
      if (i + 1 < n && src.charCodeAt(i + 1) === 0x24) {
        const close = findClosingDoubleDollar(src, i + 2)

        if (close > i + 2) {
          const mathText = src.slice(i + 2, close).trim()

          if (mathText.length > 0) {
            flushText(i)
            nodes.push({ type: "math", source: mathText, delimiter: "double-dollar", display: true })
            i = close + 2
            textStart = i
            continue
          }
        }

        i += 2
        continue
      }

      const close = findClosingDollar(src, i + 1)

      if (close > i + 1) {
        const mathText = src.slice(i + 1, close).trim()

        if (mathText.length > 0) {
          flushText(i)
          nodes.push({ type: "math", source: mathText, delimiter: "dollar", display: false })
          i = close + 1
          textStart = i
          continue
        }
      }

      i++
      continue
    }

    // 5. Image `![alt](src)` or Link `[label](href)` / `[label][id]`
    if (c === 0x5b /* [ */ || (c === 0x21 /* ! */ && i + 1 < n && src.charCodeAt(i + 1) === 0x5b)) {
      const isImage = c === 0x21
      const labelStart = isImage ? i + 2 : i + 1
      const labelEnd = findClosingBracket(src, labelStart)

      if (labelEnd >= labelStart) {
        const label = src.slice(labelStart, labelEnd)
        const afterBracket = labelEnd + 1

        // 5a. Inline link/image `(href "title")`
        if (afterBracket < n && src.charCodeAt(afterBracket) === 0x28 /* ( */) {
          const destEnd = findClosingParen(src, afterBracket + 1)

          if (destEnd >= afterBracket + 1) {
            flushText(i)
            const rawDest = src.slice(afterBracket + 1, destEnd).trim()
            const { href, title } = parseLinkDest(rawDest)

            if (isImage) {
              const imageNode: Extract<InlineNode, { type: "image" }> = { type: "image", alt: label, src: href }
              if (title) imageNode.title = title
              nodes.push(imageNode)
            } else {
              const linkNode: Extract<InlineNode, { type: "link" }> = {
                type: "link",
                href,
                children: parseInlines(label, { ...options, streaming: false }),
              }
              if (title) linkNode.title = title
              nodes.push(linkNode)
            }

            i = destEnd + 1
            textStart = i
            continue
          }
        }

        // 5b. Reference link `[label][id]` or shortcut `[label]`
        if (options.defs) {
          let refId = label.toLowerCase()
          let nextCursor = afterBracket

          if (afterBracket < n && src.charCodeAt(afterBracket) === 0x5b /* [ */) {
            const refClose = src.indexOf("]", afterBracket + 1)

            if (refClose >= afterBracket + 1) {
              const explicitRef = src.slice(afterBracket + 1, refClose).trim()
              if (explicitRef) refId = explicitRef.toLowerCase()
              nextCursor = refClose + 1
            }
          }

          const def = options.defs.get(refId)

          if (def) {
            options.onUsedRef?.(refId)
            flushText(i)

            if (isImage) {
              const imageNode: Extract<InlineNode, { type: "image" }> = { type: "image", alt: label, src: def.href }
              if (def.title) imageNode.title = def.title
              nodes.push(imageNode)
            } else {
              const linkNode: Extract<InlineNode, { type: "link" }> = {
                type: "link",
                href: def.href,
                children: parseInlines(label, { ...options, streaming: false }),
              }
              if (def.title) linkNode.title = def.title
              nodes.push(linkNode)
            }

            i = nextCursor
            textStart = i
            continue
          } else {
            options.onUnresolvedRef?.(refId)
          }
        }
      }

      i++
      continue
    }

    // 6. Angle-bracket autolink `<https://...>`
    if (c === 0x3c /* < */) {
      const close = src.indexOf(">", i + 1)

      if (close > i + 1) {
        const inner = src.slice(i + 1, close)

        if (/^https?:\/\/[^\s<>]+$/.test(inner)) {
          flushText(i)
          nodes.push({
            type: "link",
            href: inner,
            children: [{ type: "text", text: inner }],
          })
          i = close + 1
          textStart = i
          continue
        }
      }

      i++
      continue
    }

    // 7. GFM bare URL autolink `https://...`
    if (
      gfmEnabled &&
      c === 0x68 /* h */ &&
      (src.startsWith("https://", i) || src.startsWith("http://", i)) &&
      (i === 0 || isWhitespace(src.charCodeAt(i - 1)) || src.charCodeAt(i - 1) === 0x28)
    ) {
      let end = i

      while (end < n && !isWhitespace(src.charCodeAt(end)) && !"<>[]\"'".includes(src[end]!)) {
        end++
      }

      while (end > i && ".,!?;:)".includes(src[end - 1]!)) {
        if (src[end - 1] === ")") {
          const slice = src.slice(i, end - 1)
          const opens = (slice.match(/\(/g) ?? []).length
          const closes = (slice.match(/\)/g) ?? []).length

          if (opens > closes) break
        }

        end--
      }

      if (end > i + 8) {
        const url = src.slice(i, end)
        flushText(i)
        nodes.push({
          type: "link",
          href: url,
          children: [{ type: "text", text: url }],
        })
        i = end
        textStart = i
        continue
      }
    }

    // 8. GFM Strikethrough `~~...~~`
    if (gfmEnabled && c === 0x7e /* ~ */ && i + 1 < n && src.charCodeAt(i + 1) === 0x7e) {
      const close = findClosingDelimiter(src, i + 2, "~~")

      if (close > i + 2) {
        flushText(i)
        nodes.push({
          type: "del",
          children: tokenizeInlineRange(src.slice(i + 2, close), options),
        })
        i = close + 2
        textStart = i
        continue
      }

      i += 2
      continue
    }

    // 9. Strong / Emphasis (`*` or `_`)
    if (c === 0x2a /* * */ || c === 0x5f /* _ */) {
      const mark = src[i]!
      let run = 1
      while (i + run < n && src[i + run] === mark) run++

      if (c === 0x5f) {
        const prev = i > 0 ? src.charCodeAt(i - 1) : 0

        if (isWordChar(prev)) {
          i += run
          continue
        }
      }

      if (run >= 3) {
        const delim = mark.repeat(3)
        const close = findClosingDelimiter(src, i + 3, delim)

        if (close > i + 3) {
          flushText(i)
          nodes.push({
            type: "strong",
            children: [
              {
                type: "em",
                children: tokenizeInlineRange(src.slice(i + 3, close), options),
              },
            ],
          })
          i = close + 3
          textStart = i
          continue
        }
      }

      if (run >= 2) {
        const delim = mark.repeat(2)
        const close = findClosingDelimiter(src, i + 2, delim)

        if (close > i + 2 && !isWhitespace(src.charCodeAt(i + 2))) {
          flushText(i)
          nodes.push({
            type: "strong",
            children: tokenizeInlineRange(src.slice(i + 2, close), options),
          })
          i = close + 2
          textStart = i
          continue
        }
      }

      if (run === 1) {
        const nextChar = i + 1 < n ? src.charCodeAt(i + 1) : 0x20

        if (!isWhitespace(nextChar)) {
          const close = findSingleEmphasisClose(src, i + 1, c)

          if (close > i + 1) {
            flushText(i)
            nodes.push({
              type: "em",
              children: tokenizeInlineRange(src.slice(i + 1, close), options),
            })
            i = close + 1
            textStart = i
            continue
          }
        }
      }

      i += run
      continue
    }

    i++
  }

  flushText(n)

  return nodes
}

function findClosingBracket(src: string, from: number): number {
  const n = src.length
  let depth = 1
  let i = from

  while (i < n) {
    const c = src.charCodeAt(i)

    if (c === 0x5c /* \ */) {
      i += 2
      continue
    }

    if (c === 0x60 /* ` */) {
      let run = 1
      while (i + run < n && src.charCodeAt(i + run) === 0x60) run++
      const close = findClosingCodeTicks(src, i + run, run)

      if (close >= 0) {
        i = close + run
        continue
      }

      i += run
      continue
    }

    if (c === 0x5b /* [ */) depth++
    else if (c === 0x5d /* ] */) {
      depth--

      if (depth === 0) return i
    }

    i++
  }

  return -1
}

function findClosingParen(src: string, from: number): number {
  const n = src.length
  let depth = 1
  let i = from

  while (i < n) {
    const c = src.charCodeAt(i)

    if (c === 0x5c /* \ */) {
      i += 2
      continue
    }

    if (c === 0x0a || c === 0x0d) return -1

    if (c === 0x28 /* ( */) depth++
    else if (c === 0x29 /* ) */) {
      depth--

      if (depth === 0) return i
    }

    i++
  }

  return -1
}

function parseLinkDest(raw: string): { href: string; title?: string } {
  if (raw.startsWith("<")) {
    const close = raw.indexOf(">")

    if (close > 0) {
      const href = raw.slice(1, close)
      const rest = raw.slice(close + 1).trim()
      const title = rest.length >= 2 && (rest.startsWith('"') || rest.startsWith("'")) ? rest.slice(1, -1) : undefined

      return { href, title }
    }
  }

  const spaceIdx = raw.search(/\s/)

  if (spaceIdx < 0) return { href: raw }
  const href = raw.slice(0, spaceIdx)
  const rest = raw.slice(spaceIdx).trim()
  const title = rest.length >= 2 && (rest.startsWith('"') || rest.startsWith("'")) ? rest.slice(1, -1) : undefined

  return { href, title }
}

function findClosingDelimiter(src: string, from: number, delim: string): number {
  const n = src.length
  const dLen = delim.length
  const firstCode = delim.charCodeAt(0)
  let i = from

  while (i + dLen <= n) {
    const c = src.charCodeAt(i)

    if (c === 0x5c /* \ */) {
      i += 2
      continue
    }

    if (c === 0x60 /* ` */) {
      let run = 1
      while (i + run < n && src.charCodeAt(i + run) === 0x60) run++
      const close = findClosingCodeTicks(src, i + run, run)

      if (close >= 0) {
        i = close + run
        continue
      }

      i += run
      continue
    }

    if (c === firstCode && src.startsWith(delim, i)) {
      if (!isWhitespace(src.charCodeAt(i - 1))) {
        return i
      }
    }

    i++
  }

  return -1
}

function findSingleEmphasisClose(src: string, from: number, markCode: number): number {
  const n = src.length
  let i = from

  while (i < n) {
    const c = src.charCodeAt(i)

    if (c === 0x5c /* \ */) {
      i += 2
      continue
    }

    if (c === 0x60 /* ` */) {
      let run = 1
      while (i + run < n && src.charCodeAt(i + run) === 0x60) run++
      const close = findClosingCodeTicks(src, i + run, run)

      if (close >= 0) {
        i = close + run
        continue
      }

      i += run
      continue
    }

    if (c === markCode) {
      let run = 1
      while (i + run < n && src.charCodeAt(i + run) === markCode) run++

      if (run === 1) {
        const prev = src.charCodeAt(i - 1)
        const next = i + 1 < n ? src.charCodeAt(i + 1) : 0

        if (!isWhitespace(prev) && (markCode !== 0x5f || !isWordChar(next))) {
          return i
        }
      }

      i += run
      continue
    }

    i++
  }

  return -1
}
