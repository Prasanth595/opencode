import { Marked, type Tokens } from "marked"
import remend from "remend"
import { markdownMath } from "@opencode/ui/context/marked-parser"
import { completedProjection } from "./markdown-projection"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live" | "code"
  language?: string
  complete?: boolean
}

export type Projection = {
  text: string
  blocks: Block[]
}

// Split with the renderer's math syntax so a display block is never cut into separately rendered pieces.
const lexer = new Marked(markdownMath)

function refs(text: string) {
  if (!text.includes("]:")) return false

  return /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:\S+|\r?\n[ \t]+\S+)/m.test(text)
}

function language(value: string | undefined) {
  return value?.trim().split(/\s+/, 1)[0] || undefined
}

function openCode(raw: string) {
  const newline = raw.indexOf("\n")

  return newline < 0 ? "" : raw.slice(newline + 1)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)

  if (!match) return false
  const mark = match[1]

  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""

  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function closesFence(raw: string, suffix: string) {
  const mark = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1]

  if (!mark) return suffix.includes("```") || suffix.includes("~~~")

  return `${raw.slice(-(mark.length - 1))}${suffix}`.includes(mark)
}

function heal(text: string) {
  return remend(text, { linkMode: "text-only" })
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return completedProjection(text).blocks

  if (refs(text)) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const tokens = lexer.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== "space")

  if (tail < 0) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const last = tokens[tail]

  if (!last) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]

  const result: Block[] = []

  for (let index = 0; index < tail; index++) {
    const token = tokens[index]

    if (!token || token.type === "space") continue
    let raw = token.raw

    while (tokens[index + 1]?.type === "space" && index + 1 < tail) raw += tokens[++index]!.raw

    if (token.type === "code") {
      // SAFETY: only marked's built-in fence tokenizer emits `code`; the math extensions use their own token types.
      const code = token as Tokens.Code
      result.push({ raw, src: code.text, mode: "code", language: language(code.lang), complete: true })
      continue
    }

    result.push({ raw, src: raw, mode: "full" })
  }

  const raw = tokens
    .slice(tail)
    .map((token) => token.raw)
    .join("")

  if (last.type !== "code") return [...result, { raw, src: heal(raw), mode: "live" }]

  // SAFETY: only marked's built-in fence tokenizer emits `code`; the math extensions use their own token types.
  const code = last as Tokens.Code

  if (!open(code.raw))
    return [...result, { raw, src: code.text, mode: "code", language: language(code.lang), complete: true }]

  return [...result, { raw, src: openCode(code.raw), mode: "code", language: language(code.lang) }]
}

// Streaming projection bounds the work done per delta. Re-lexing the whole
// accumulated text on every delta is O(n²) for a long single part and freezes
// the UI; while a tail block is still open we grow it in place, only re-lexing
// when the appended text introduces a block boundary (a blank line) or the tail
// exceeds this cap. A boundary-less tail (one giant paragraph, list, or table)
// keeps growing in place past the cap so it is never re-lexed on every delta.
const LIVE_TAIL_MAX = 2048

function hasBlockBoundary(text: string) {
  return text.includes("\n\n")
}

// A fenced code block must be projected in `code` mode so the worker streams
// syntax highlighting. Detect a fence opening at a line start anywhere in the
// growing tail so a fence that arrives inside a live tail re-projects promptly
// instead of waiting for the cap or for streaming to stop. A live tail cannot
// hold a *closed* fence (that token would have been frozen on its own), so any
// line-start fence marker here means the tail is becoming a code block.
function opensFence(raw: string) {
  return /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/.test(raw)
}

export function project(previous: Projection | undefined, text: string, live: boolean): Projection {
  if (!live) {
    const current =
      previous?.text === text
        ? previous
        : previous && text.startsWith(previous.text)
          ? project(previous, text, true)
          : undefined

    if (!current) return completedProjection(text)

    return {
      text,
      blocks: current.blocks.map((block) => {
        if (block.mode === "live") return { raw: block.raw, src: block.raw, mode: "full" }

        if (block.mode === "code" && !block.complete) return { ...block, complete: true }

        return block
      }),
    }
  }

  if (!previous || !text.startsWith(previous.text)) return { text, blocks: stream(text, live) }
  const tail = previous.blocks.at(-1)
  const suffix = text.slice(previous.text.length)

  if (!suffix) return previous

  if (tail?.mode === "live") {
    // Reference definitions resolve against the whole document. When one arrives
    // after earlier blocks were frozen, fall back to a full re-lex so it can
    // merge with its uses (see `stream`). Once merged, `stream` collapses the
    // text into a single live block and later deltas grow it in place again.
    if (refs(suffix) || (previous.blocks.length > 1 && refs(tail.raw + suffix)))
      return { text, blocks: stream(text, live) }

    const raw = tail.raw + suffix

    if (opensFence(raw)) return { text, blocks: [...previous.blocks.slice(0, -1), ...stream(raw, true)] }

    if (raw.length <= LIVE_TAIL_MAX || !hasBlockBoundary(suffix))
      return { text, blocks: [...previous.blocks.slice(0, -1), { ...tail, raw, src: heal(raw) }] }

    return { text, blocks: [...previous.blocks.slice(0, -1), ...stream(raw, true)] }
  }

  if (tail?.mode === "code" && !tail.complete && !closesFence(tail.raw, suffix)) {
    return {
      text,
      blocks: [
        ...previous.blocks.slice(0, -1),
        {
          ...tail,
          raw: tail.raw + suffix,
          src: tail.src + suffix,
        },
      ],
    }
  }

  return { text, blocks: stream(text, live) }
}
