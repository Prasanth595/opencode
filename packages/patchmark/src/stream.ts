import { escapeHtml, renderBlockKindToHtml } from "./html"
import { parseInlines, type InlineParseOptions, type ReferenceDef } from "./inline"
import type {
  BlockKind,
  BlockPatch,
  HeadingLevel,
  InlineNode,
  MarkdownBlock,
  StreamFrame,
  StreamOptions,
  TableAlign,
} from "./types"

const DEF_LINE_RE = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+["'(]([^"')]+)["')])?[ \t]*$/
const DEF_OPEN_RE = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*$/
const DEF_CONT_RE = /^[ \t]+<?([^\s>]+)>?(?:[ \t]+["'(]([^"')]+)["')])?[ \t]*$/

const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6]

/**
 * If `streaming` is true and the last line holds only a bare block opener
 * (`-`, `*`, `+`, `##`, `12.`, `>`, ```` ``` ````, `$$`), hold that line back until its
 * first content character or newline arrives. Prevents 1-frame paragraph-to-heading/list pops.
 */
export function splitPendingMarker(text: string): { visible: string; held: string } {
  const lastNl = text.lastIndexOf("\n")
  const lineStart = lastNl + 1
  const tailLine = text.slice(lineStart)

  if (!tailLine || tailLine.length > 12) return { visible: text, held: "" }

  const trimmed = tailLine.trim()

  if (!trimmed) return { visible: text, held: "" }

  const first = trimmed.charCodeAt(0)

  // `#`, `` ` ``, `~`, `-`, `*`, `_`, `$`
  if (
    first === 0x23 /* # */ ||
    first === 0x60 /* ` */ ||
    first === 0x7e /* ~ */ ||
    first === 0x2d /* - */ ||
    first === 0x2a /* * */ ||
    first === 0x5f /* _ */ ||
    first === 0x24 /* $ */
  ) {
    let allSame = true

    for (let i = 1; i < trimmed.length; i++) {
      if (trimmed.charCodeAt(i) !== first) {
        allSame = false
        break
      }
    }

    if (allSame) {
      const maxHold = first === 0x23 ? 6 : first === 0x60 || first === 0x7e ? 3 : 2

      if (trimmed.length <= maxHold) {
        return { visible: text.slice(0, lineStart), held: tailLine }
      }
    }
  }

  if (trimmed === "+" || trimmed === "•" || trimmed === ">" || trimmed === "\\[") {
    return { visible: text.slice(0, lineStart), held: tailLine }
  }

  // Bare ordered list marker `1`, `12.`, `1)`
  let d = 0
  while (d < trimmed.length && trimmed.charCodeAt(d) >= 0x30 && trimmed.charCodeAt(d) <= 0x39) d++

  if (d > 0) {
    const rest = trimmed.slice(d)

    if (rest === "" || rest === "." || rest === ")") {
      return { visible: text.slice(0, lineStart), held: tailLine }
    }
  }

  return { visible: text, held: "" }
}

interface RawParsedBlock {
  start: number
  end: number
  raw: string
  kind: BlockKind
  canSettle: boolean
  selfSettled?: boolean
  listIndentsAfter: number[]
  unresolvedRefs?: string[]
  usedRefs?: string[]
  def?: { id: string; href: string; title?: string; raw: string }
}

function isThematicBreak(trimmed: string): boolean {
  if (trimmed.length < 3) return false
  const first = trimmed.charCodeAt(0)

  if (first !== 0x2d /* - */ && first !== 0x2a /* * */ && first !== 0x5f /* _ */) return false
  let count = 0

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i)

    if (c === first) count++
    else if (c !== 0x20 && c !== 0x09) return false
  }

  return count >= 3
}

function isTableSeparator(trimmed: string): boolean {
  if (!trimmed.includes("|") || !trimmed.includes("-")) return false

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i)

    if (c !== 0x7c /* | */ && c !== 0x2d /* - */ && c !== 0x3a /* : */ && c !== 0x20 && c !== 0x09) {
      return false
    }
  }

  return true
}

function parseTableAlign(separator: string): TableAlign[] {
  let body = separator.trim()
  if (body.startsWith("|")) body = body.slice(1)
  if (body.endsWith("|")) body = body.slice(0, -1)

  return body.split("|").map((cell) => {
    const c = cell.trim()
    const left = c.startsWith(":")
    const right = c.endsWith(":")

    if (left && right) return "center"
    if (right) return "right"
    if (left) return "left"

    return null
  })
}

function splitTableCells(line: string): string[] {
  let body = line.trim()
  if (body.startsWith("|")) body = body.slice(1)
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1)
  const cells: string[] = []
  let start = 0
  let inTicks = false

  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i)

    if (c === 0x5c /* \ */) {
      i++
      continue
    }

    if (c === 0x60 /* ` */) {
      inTicks = !inTicks
      continue
    }

    if (c === 0x7c /* | */ && !inTicks) {
      cells.push(body.slice(start, i).trim())
      start = i + 1
    }
  }

  cells.push(body.slice(start).trim())

  return cells
}

function matchListMarker(line: string): {
  indent: number
  ordered: boolean
  marker: string
  start?: number
  content: string
} | null {
  let i = 0
  let indent = 0

  while (i < line.length) {
    const c = line.charCodeAt(i)

    if (c === 0x20) {
      indent++
      i++
    } else if (c === 0x09) {
      indent += 4
      i++
    } else {
      break
    }
  }

  if (i >= line.length) return null
  const first = line.charCodeAt(i)

  // Bullet `- `, `* `, `+ `, `• `
  if (
    (first === 0x2d || first === 0x2a || first === 0x2b || first === 0x2022) &&
    i + 1 < line.length &&
    (line.charCodeAt(i + 1) === 0x20 || line.charCodeAt(i + 1) === 0x09)
  ) {
    return {
      indent,
      ordered: false,
      marker: line[i]!,
      content: line.slice(i + 2),
    }
  }

  // Ordered `1. ` or `1) `
  if (first >= 0x30 && first <= 0x39) {
    let d = i
    while (d < line.length && line.charCodeAt(d) >= 0x30 && line.charCodeAt(d) <= 0x39) d++

    if (
      d - i <= 9 &&
      d + 1 < line.length &&
      (line.charCodeAt(d) === 0x2e /* . */ || line.charCodeAt(d) === 0x29) /* ) */ &&
      (line.charCodeAt(d + 1) === 0x20 || line.charCodeAt(d + 1) === 0x09)
    ) {
      const marker = line.slice(i, d + 1)

      return {
        indent,
        ordered: true,
        marker,
        start: Number.parseInt(line.slice(i, d), 10),
        content: line.slice(d + 2),
      }
    }
  }

  return null
}

function matchFenceOpen(line: string): {
  indent: number
  fence: string
  char: number
  len: number
  language?: string
  meta?: string
} | null {
  let i = 0
  let indent = 0

  while (i < line.length) {
    const c = line.charCodeAt(i)

    if (c === 0x20) {
      indent++
      i++
    } else if (c === 0x09) {
      indent += 4
      i++
    } else {
      break
    }
  }

  if (i + 2 >= line.length) return null
  const ch = line.charCodeAt(i)

  if (ch !== 0x60 /* ` */ && ch !== 0x7e /* ~ */) return null
  let run = 1
  while (i + run < line.length && line.charCodeAt(i + run) === ch) run++

  if (run < 3) return null
  const info = line.slice(i + run).trim()

  // CommonMark rule: backtick fence info string cannot contain backticks
  if (ch === 0x60 && info.includes("`")) return null
  const parts = info ? info.split(/\s+/) : []
  const language = parts[0] || undefined
  const meta = parts.length > 1 ? parts.slice(1).join(" ") : undefined
  const result: {
    indent: number
    fence: string
    char: number
    len: number
    language?: string
    meta?: string
  } = {
    indent,
    fence: line.slice(i, i + run),
    char: ch,
    len: run,
  }

  if (language) result.language = language
  if (meta) result.meta = meta

  return result
}

function isFenceClose(line: string, fenceChar: number, minLen: number): boolean {
  let i = 0
  while (i < line.length && (line.charCodeAt(i) === 0x20 || line.charCodeAt(i) === 0x09)) i++
  let run = 0

  while (i < line.length && line.charCodeAt(i) === fenceChar) {
    run++
    i++
  }

  if (run < minLen) return false

  while (i < line.length) {
    const c = line.charCodeAt(i)

    if (c !== 0x20 && c !== 0x09 && c !== 0x0d) return false
    i++
  }

  return true
}

function matchStandaloneImage(trimmed: string): { alt: string; src: string; title?: string } | null {
  if (!trimmed.startsWith("![") || !trimmed.endsWith(")")) return null
  const sep = trimmed.indexOf("](")

  if (sep < 2) return null
  const alt = trimmed.slice(2, sep)
  const rawDest = trimmed.slice(sep + 2, -1).trim()

  if (!rawDest || rawDest.includes(")")) return null
  const spaceIdx = rawDest.search(/\s/)

  if (spaceIdx < 0) return { alt, src: rawDest }
  const src = rawDest.slice(0, spaceIdx)
  const rest = rawDest.slice(spaceIdx).trim()
  const title = rest.length >= 2 && (rest.startsWith('"') || rest.startsWith("'")) ? rest.slice(1, -1) : undefined
  const result: { alt: string; src: string; title?: string } = { alt, src }

  if (title) result.title = title

  return result
}

export class PatchmarkStream {
  private readonly options: Required<StreamOptions>
  private fullText = ""
  private blocks: MarkdownBlock[] = []
  private settledCount = 0
  private settledOffset = 0
  private settledListIndents: number[] = []
  private nextId = 0
  private readonly defs = new Map<string, ReferenceDef>()
  private readonly refToBlockIds = new Map<string, Set<number>>()
  private readonly blockIdToRefs = new Map<number, Set<string>>()
  private readonly tableRowCache = new Map<string, InlineNode[][]>()
  private activeTableState: {
    blockStart: number
    committedOffset: number
    align: TableAlign[]
    headers: InlineNode[][]
    committedRows: InlineNode[][][]
  } | null = null

  constructor(options: StreamOptions = {}) {
    this.options = {
      gfm: options.gfm ?? true,
      math: options.math ?? true,
      heal: options.heal ?? true,
      holdPendingMarkers: options.holdPendingMarkers ?? true,
      flatListBlocks: options.flatListBlocks ?? true,
      settleOnComplete: options.settleOnComplete ?? true,
      renderHtml: options.renderHtml ?? false,
    }
  }

  /** Reset the stream to empty state */
  reset(): void {
    this.fullText = ""
    this.blocks = []
    this.settledCount = 0
    this.settledOffset = 0
    this.settledListIndents = []
    this.nextId = 0
    this.defs.clear()
    this.refToBlockIds.clear()
    this.blockIdToRefs.clear()
    this.tableRowCache.clear()
    this.activeTableState = null
  }

  /** Current full text */
  getText(): string {
    return this.fullText
  }

  /** Current blocks snapshot */
  getBlocks(): ReadonlyArray<MarkdownBlock> {
    return this.blocks
  }

  /** Append a streaming delta chunk in O(|delta| + |tail|) time */
  append(delta: string): StreamFrame {
    if (!delta) {
      return {
        text: this.fullText,
        settledOffset: this.settledOffset,
        blocks: this.getBlocks(),
        patches: [],
        heldMarker: "",
        charsScanned: 0,
      }
    }

    this.fullText += delta

    return this.reconcileTail(true, delta)
  }

  /** Declarative update: handles prefix append in O(|delta| + |tail|), or resets on non-prefix replacement */
  update(text: string, opts: { streaming?: boolean } = {}): StreamFrame {
    const streaming = opts.streaming ?? true

    if (text === this.fullText) {
      if (!streaming) return this.finalize()

      return {
        text: this.fullText,
        settledOffset: this.settledOffset,
        blocks: this.getBlocks(),
        patches: [],
        heldMarker: "",
        charsScanned: 0,
      }
    }

    if (this.fullText.length > 0 && text.startsWith(this.fullText)) {
      const delta = text.slice(this.fullText.length)
      this.fullText = text

      return this.reconcileTail(streaming, delta)
    }

    // Non-prefix replacement or truncation: check how many settled blocks still match
    let keepSettled = 0
    let keepOffset = 0

    while (keepSettled < this.settledCount) {
      const b = this.blocks[keepSettled]!

      if (text.length >= b.end && text.startsWith(b.raw, b.start)) {
        keepOffset = b.end
        keepSettled++
      } else {
        break
      }
    }

    const patches: BlockPatch[] = []
    const prevTotal = this.blocks.length

    if (keepSettled < prevTotal) {
      patches.push({ op: "truncate", keepCount: keepSettled })
    }

    this.blocks.length = keepSettled
    this.settledCount = keepSettled
    this.settledOffset = keepOffset
    if (keepSettled === 0) this.settledListIndents = []
    this.activeTableState = null
    this.fullText = text

    const frame = this.reconcileTail(streaming, "")

    return {
      ...frame,
      patches: patches.length > 0 ? [...patches, ...frame.patches] : frame.patches,
    }
  }

  /** Finalize the stream: flush any held markers and transition the active tail block(s) to "settled" */
  finalize(): StreamFrame {
    return this.reconcileTail(false, "")
  }

  private resolveDefsForBlock(id: number): string | undefined {
    const refs = this.blockIdToRefs.get(id)

    if (!refs || refs.size === 0) return undefined
    const lines: string[] = []

    for (const refId of refs) {
      const def = this.defs.get(refId)
      if (def?.raw) lines.push(def.raw.trimEnd())
    }

    return lines.length > 0 ? lines.join("\n") : undefined
  }

  private reconcileTail(streaming: boolean, delta: string): StreamFrame {
    const patches: BlockPatch[] = []
    const tailCount = this.blocks.length - this.settledCount

    const tail = tailCount === 1 ? this.blocks[this.settledCount] : undefined
    const tailKind = tail?.kind

    // Fast path: if the sole tail block is an open code fence (whose opening fence line is already complete) and the delta cannot close it
    if (
      streaming &&
      delta.length > 0 &&
      tail &&
      tailKind?.type === "code" &&
      !tailKind.complete &&
      tail.raw.includes("\n") &&
      (!tailKind.indented || !delta.includes("\n"))
    ) {
      const fence = tailKind.fence
      const prevLastNl = tail.raw.lastIndexOf("\n")
      const affectedTail = tail.raw.slice(prevLastNl + 1) + delta

      if (!affectedTail.includes(fence)) {
        const updatedKind: BlockKind = {
          ...tailKind,
          source: tailKind.source + delta,
        }

        const updatedHtml =
          this.options.renderHtml && tail.html
            ? `${tail.html.slice(0, -14)}${escapeHtml(delta)}</code></pre>\n`
            : this.options.renderHtml
              ? renderBlockKindToHtml(updatedKind)
              : undefined

        const updatedBlock: MarkdownBlock = {
          id: tail.id,
          start: tail.start,
          end: this.fullText.length,
          raw: tail.raw + delta,
          status: "streaming",
          kind: updatedKind,
        }

        if (updatedHtml !== undefined) updatedBlock.html = updatedHtml
        this.blocks[this.settledCount] = updatedBlock
        patches.push({
          op: "replace",
          id: updatedBlock.id,
          index: this.settledCount,
          block: updatedBlock,
        })

        return {
          text: this.fullText,
          settledOffset: this.settledOffset,
          blocks: this.blocks,
          patches,
          heldMarker: "",
          charsScanned: affectedTail.length,
        }
      }
    }

    // Fast path: if the sole tail block is an open GFM table and new text continues adding table rows
    if (
      streaming &&
      delta.length > 0 &&
      tailCount === 1 &&
      this.blocks[this.settledCount]!.kind.type === "table" &&
      this.activeTableState &&
      this.activeTableState.blockStart === this.settledOffset
    ) {
      const state = this.activeTableState
      const tailSlice = this.fullText.slice(state.committedOffset)
      const lines = tailSlice.split("\n")
      let validTableContinuation = true

      for (let l = 0; l < lines.length; l++) {
        const lt = lines[l]!.replace(/\r$/, "").trim()
        if (l === lines.length - 1 && lt.length === 0) continue

        if (!lt || !lt.includes("|") || matchFenceOpen(lt) || lt.startsWith("#")) {
          validTableContinuation = false
          break
        }
      }

      if (validTableContinuation) {
        const unresolved: string[] = []
        const used: string[] = []
        let advanced = 0

        for (let l = 0; l < lines.length - 1; l++) {
          const rawLine = lines[l]!
          const lt = rawLine.replace(/\r$/, "").trim()

          const parsedRow = splitTableCells(lt).map((cell) =>
            parseInlines(cell, this.inlineOpts(false, unresolved, used)),
          )

          state.committedRows.push(parsedRow)
          advanced += rawLine.length + 1
        }

        state.committedOffset += advanced
        const lastLine = lines[lines.length - 1]!.replace(/\r$/, "").trim()

        const allRows = lastLine
          ? [
              ...state.committedRows,
              splitTableCells(lastLine).map((cell) => parseInlines(cell, this.inlineOpts(true, unresolved, used))),
            ]
          : [...state.committedRows]

        const tail = this.blocks[this.settledCount]!
        const updatedKind: BlockKind = {
          type: "table",
          align: state.align,
          headers: state.headers,
          rows: allRows,
        }

        const updatedBlock: MarkdownBlock = {
          id: tail.id,
          start: tail.start,
          end: this.fullText.length,
          raw: this.fullText.slice(tail.start),
          status: "streaming",
          kind: updatedKind,
        }

        if (this.options.renderHtml) updatedBlock.html = renderBlockKindToHtml(updatedKind)
        this.blocks[this.settledCount] = updatedBlock
        patches.push({
          op: "replace",
          id: updatedBlock.id,
          index: this.settledCount,
          block: updatedBlock,
        })

        return {
          text: this.fullText,
          settledOffset: this.settledOffset,
          blocks: this.blocks,
          patches,
          heldMarker: "",
          charsScanned: tailSlice.length,
        }
      }

      this.activeTableState = null
    }

    const rawTail = this.fullText.slice(this.settledOffset)
    const { visible: activeSlice, held } =
      streaming && this.options.holdPendingMarkers
        ? splitPendingMarker(rawTail)
        : { visible: rawTail, held: "" }

    const rawBlocks = this.parseSlice(activeSlice, this.settledOffset, streaming)
    const visibleBlocks: RawParsedBlock[] = []

    for (let i = 0; i < rawBlocks.length; i++) {
      const rb = rawBlocks[i]!

      if (rb.def) {
        if (!this.options.settleOnComplete && visibleBlocks.length > 0) {
          const prevVis = visibleBlocks[visibleBlocks.length - 1]!
          prevVis.end = rb.end
          prevVis.raw = this.fullText.slice(prevVis.start, rb.end)
          prevVis.canSettle = false
          prevVis.selfSettled = false
        }

        continue
      }

      visibleBlocks.push(rb)
    }

    const prevTail = this.blocks.slice(this.settledCount)
    this.blocks.length = this.settledCount

    if (prevTail.length > visibleBlocks.length) {
      patches.push({ op: "truncate", keepCount: this.settledCount + visibleBlocks.length })
    }

    for (let i = 0; i < visibleBlocks.length; i++) {
      const rb = visibleBlocks[i]!
      const isLast = i === visibleBlocks.length - 1
      const shouldSettle =
        !streaming || (this.options.settleOnComplete && rb.selfSettled === true) || (!isLast && rb.canSettle)
      const status: "streaming" | "settled" = shouldSettle ? "settled" : "streaming"

      const existingTail = i < prevTail.length ? prevTail[i] : undefined
      const id = existingTail ? existingTail.id : this.nextId++
      const blockIndex = this.blocks.length

      const allRefs = [...(rb.unresolvedRefs ?? []), ...(rb.usedRefs ?? [])]

      if (allRefs.length > 0) {
        let blockSet = this.blockIdToRefs.get(id)

        if (!blockSet) {
          blockSet = new Set()
          this.blockIdToRefs.set(id, blockSet)
        }

        for (const refId of allRefs) {
          blockSet.add(refId)
          let set = this.refToBlockIds.get(refId)

          if (!set) {
            set = new Set()
            this.refToBlockIds.set(refId, set)
          }

          set.add(id)
        }
      }

      const resolvedDefs = this.resolveDefsForBlock(id)
      const block: MarkdownBlock = {
        id,
        start: rb.start,
        end: rb.end,
        raw: rb.raw,
        status,
        kind: rb.kind,
      }

      if (this.options.renderHtml) block.html = renderBlockKindToHtml(rb.kind)
      if (resolvedDefs && !block.raw.includes(resolvedDefs)) block.defs = resolvedDefs

      if (shouldSettle) {
        this.blocks.push(block)
        this.settledCount++
        this.settledOffset = rb.end
        this.settledListIndents = rb.listIndentsAfter

        if (existingTail) {
          patches.push({ op: "finalize", id: block.id, index: blockIndex, block })
        } else {
          patches.push({ op: "append", block })
          patches.push({ op: "finalize", id: block.id, index: blockIndex, block })
        }

        if (block.kind.type === "table") {
          this.tableRowCache.clear()
          this.activeTableState = null
        }
      } else {
        if (existingTail) {
          if (
            existingTail.raw !== block.raw ||
            existingTail.status !== block.status ||
            existingTail.defs !== block.defs
          ) {
            this.blocks.push(block)
            patches.push({ op: "replace", id: block.id, index: blockIndex, block })
          } else {
            this.blocks.push(existingTail)
          }
        } else {
          this.blocks.push(block)
          patches.push({ op: "append", block })
        }
      }
    }

    // Process any newly discovered or updated reference definitions `[id]: url`
    for (const rb of rawBlocks) {
      if (rb.def) {
        const prev = this.defs.get(rb.def.id)

        if (!prev || prev.href !== rb.def.href || prev.title !== rb.def.title) {
          this.defs.set(rb.def.id, { href: rb.def.href, title: rb.def.title, raw: rb.def.raw })
          const waitingIds = this.refToBlockIds.get(rb.def.id)

          if (waitingIds) {
            for (const blockId of waitingIds) {
              let idx = -1

              for (let s = 0; s < this.blocks.length; s++) {
                if (this.blocks[s]!.id === blockId) {
                  idx = s
                  break
                }
              }

              if (idx >= 0) {
                const oldBlock = this.blocks[idx]!
                const reparsed = this.parseSlice(oldBlock.raw, oldBlock.start, false)[0]

                if (reparsed) {
                  const resolvedDefs = this.resolveDefsForBlock(oldBlock.id)
                  const updated: MarkdownBlock = {
                    ...oldBlock,
                    kind: reparsed.kind,
                  }

                  if (this.options.renderHtml) updated.html = renderBlockKindToHtml(reparsed.kind)
                  if (resolvedDefs && !updated.raw.includes(resolvedDefs)) updated.defs = resolvedDefs
                  this.blocks[idx] = updated
                  patches.push({ op: "replace", id: updated.id, index: idx, block: updated })
                }
              }
            }
          }
        }
      }
    }

    return {
      text: this.fullText,
      settledOffset: this.settledOffset,
      blocks: this.blocks,
      patches,
      heldMarker: held,
      charsScanned: activeSlice.length,
    }
  }

  private parseSlice(slice: string, baseOffset: number, streaming: boolean): RawParsedBlock[] {
    if (!slice) return []
    const results: RawParsedBlock[] = []

    const lineStarts: number[] = []
    const lineEnds: number[] = []
    let pos = 0
    const len = slice.length

    while (pos < len) {
      lineStarts.push(pos)
      const nl = slice.indexOf("\n", pos)

      if (nl < 0) {
        lineEnds.push(len)
        pos = len
      } else {
        lineEnds.push(nl + 1)
        pos = nl + 1
      }
    }

    const lineCount = lineStarts.length
    const isLineComplete = (idx: number): boolean => {
      if (!streaming || idx < lineCount - 1) return true

      return slice.charCodeAt(lineEnds[idx]! - 1) === 0x0a
    }

    const getLine = (idx: number): string => {
      let s = slice.slice(lineStarts[idx]!, lineEnds[idx]!)
      if (s.endsWith("\n")) s = s.slice(0, -1)
      if (s.endsWith("\r")) s = s.slice(0, -1)

      return s
    }

    const consumeTrailingBlankLines = (nextIdx: number): number => {
      let idx = nextIdx
      while (idx < lineCount && isLineComplete(idx) && getLine(idx).trim().length === 0) {
        idx++
      }

      return idx
    }

    let listIndents: number[] = [...this.settledListIndents]
    let idx = 0

    while (idx < lineCount) {
      const line = getLine(idx)
      const trimmed = line.trim()

      if (trimmed.length === 0) {
        idx++
        continue
      }

      const blockStartLine = idx

      // 1a. Single-line reference link definition `[id]: url "title"`
      const defMatch = (!this.options.settleOnComplete || isLineComplete(idx)) ? DEF_LINE_RE.exec(line) : null

      if (defMatch) {
        const nextIdx = consumeTrailingBlankLines(idx + 1)
        const start = baseOffset + lineStarts[blockStartLine]!
        const end = baseOffset + lineEnds[nextIdx - 1]!
        const raw = slice.slice(lineStarts[blockStartLine]!, lineEnds[nextIdx - 1]!)
        const def: { id: string; href: string; title?: string; raw: string } = {
          id: defMatch[1]!.toLowerCase(),
          href: defMatch[2]!,
          raw,
        }

        if (defMatch[3]) def.title = defMatch[3]
        results.push({
          start,
          end,
          raw,
          kind: { type: "paragraph", inlines: [] },
          canSettle: true,
          listIndentsAfter: [...listIndents],
          def,
        })
        idx = nextIdx
        continue
      }

      // 1b. Multiline reference link definition `[id]:\n  url`
      const defOpen = idx + 1 < lineCount ? DEF_OPEN_RE.exec(line) : null
      const defCont = defOpen ? DEF_CONT_RE.exec(getLine(idx + 1)) : null

      if (defOpen && defCont) {
        const nextIdx = consumeTrailingBlankLines(idx + 2)
        const start = baseOffset + lineStarts[blockStartLine]!
        const end = baseOffset + lineEnds[nextIdx - 1]!
        const raw = slice.slice(lineStarts[blockStartLine]!, lineEnds[nextIdx - 1]!)
        const def: { id: string; href: string; title?: string; raw: string } = {
          id: defOpen[1]!.toLowerCase(),
          href: defCont[1]!,
          raw,
        }

        if (defCont[2]) def.title = defCont[2]
        results.push({
          start,
          end,
          raw,
          kind: { type: "paragraph", inlines: [] },
          canSettle: true,
          listIndentsAfter: [...listIndents],
          def,
        })
        idx = nextIdx
        continue
      }

      // 2. Fenced code block or Mermaid block (```` ``` ```` or `~~~`, top-level or list-indented)
      const fenceOpen = matchFenceOpen(line)

      if (fenceOpen && (fenceOpen.indent <= 3 || this.options.flatListBlocks || listIndents.length > 0)) {
        const bodyStartLine = idx + 1
        let closeLine = -1

        for (let k = bodyStartLine; k < lineCount; k++) {
          if (
            (!this.options.settleOnComplete || isLineComplete(k)) &&
            isFenceClose(getLine(k), fenceOpen.char, fenceOpen.len)
          ) {
            closeLine = k
            break
          }
        }

        const complete = closeLine >= 0
        const endLineExcl = complete ? consumeTrailingBlankLines(closeLine + 1) : lineCount
        const codeLines: string[] = []
        const bodyEnd = complete ? closeLine : lineCount

        for (let k = bodyStartLine; k < bodyEnd; k++) {
          const rawCodeLine = getLine(k)
          let strip = 0
          while (strip < fenceOpen.indent && strip < rawCodeLine.length && rawCodeLine.charCodeAt(strip) === 0x20) {
            strip++
          }
          codeLines.push(strip > 0 ? rawCodeLine.slice(strip) : rawCodeLine)
        }

        const start = baseOffset + lineStarts[blockStartLine]!
        const end = baseOffset + lineEnds[endLineExcl - 1]!
        const raw = slice.slice(lineStarts[blockStartLine]!, lineEnds[endLineExcl - 1]!)
        let source = codeLines.join("\n")

        if (!complete && codeLines.length > 0 && raw.endsWith("\n")) {
          source += "\n"
        }

        const isMermaid = fenceOpen.language?.toLowerCase() === "mermaid"
        let kind: BlockKind

        if (isMermaid) {
          kind = { type: "mermaid", source, complete }
        } else {
          const codeKind: Extract<BlockKind, { type: "code" }> = {
            type: "code",
            source,
            fence: fenceOpen.fence,
            complete,
          }

          if (fenceOpen.language) codeKind.language = fenceOpen.language
          if (fenceOpen.meta) codeKind.meta = fenceOpen.meta
          if (fenceOpen.indent > 0) codeKind.indented = true
          kind = codeKind
        }

        const closeComplete = complete && isLineComplete(closeLine)

        results.push({
          start,
          end,
          raw,
          kind,
          canSettle: closeComplete,
          selfSettled: closeComplete,
          listIndentsAfter: [...listIndents],
        })
        idx = endLineExcl
        continue
      }

      // 3. Display math block (`$$...$$` or `\[...\]` or `$\n...\n$`)
      if (this.options.math && (trimmed.startsWith("$$") || trimmed.startsWith("\\[") || trimmed === "$")) {
        const isBracket = trimmed.startsWith("\\[")
        const isSingleDollar = trimmed === "$"
        const closeDelim = isBracket ? "\\]" : isSingleDollar ? "$" : "$$"
        const delimType = isBracket ? "bracket" : "double-dollar"
        const afterOpen = trimmed.slice(closeDelim.length)

        // Single-line display math `$$ ... $$`
        if (!isSingleDollar && afterOpen.endsWith(closeDelim) && afterOpen.length > closeDelim.length) {
          const mathSrc = afterOpen.slice(0, -2).trim()
          const nextIdx = consumeTrailingBlankLines(idx + 1)
          listIndents = []
          results.push({
            start: baseOffset + lineStarts[blockStartLine]!,
            end: baseOffset + lineEnds[nextIdx - 1]!,
            raw: slice.slice(lineStarts[blockStartLine]!, lineEnds[nextIdx - 1]!),
            kind: { type: "math", source: mathSrc, delimiter: delimType, complete: true },
            canSettle: isLineComplete(idx),
            selfSettled: isLineComplete(idx),
            listIndentsAfter: [],
          })
          idx = nextIdx
          continue
        }

        // Multi-line display math
        if (!afterOpen.includes(closeDelim)) {
          let closeLine = -1
          const mathLines: string[] = afterOpen.trim() ? [afterOpen] : []

          for (let k = idx + 1; k < lineCount; k++) {
            const mLine = getLine(k).trim()

            if (
              (!this.options.settleOnComplete || isLineComplete(k)) &&
              (isSingleDollar ? mLine === "$" : mLine.endsWith(closeDelim))
            ) {
              const beforeClose = mLine.slice(0, -closeDelim.length).trim()
              if (beforeClose) mathLines.push(beforeClose)
              closeLine = k
              break
            }

            mathLines.push(getLine(k))
          }

          if (closeLine >= 0 || (!isSingleDollar && streaming && idx + 1 <= lineCount)) {
            const complete = closeLine >= 0
            const endLineExcl = complete ? consumeTrailingBlankLines(closeLine + 1) : lineCount
            const closeComplete = complete && isLineComplete(closeLine)
            listIndents = []
            results.push({
              start: baseOffset + lineStarts[blockStartLine]!,
              end: baseOffset + lineEnds[endLineExcl - 1]!,
              raw: slice.slice(lineStarts[blockStartLine]!, lineEnds[endLineExcl - 1]!),
              kind: {
                type: "math",
                source: mathLines.join("\n").trim(),
                delimiter: delimType,
                complete,
              },
              canSettle: closeComplete,
              selfSettled: closeComplete,
              listIndentsAfter: [],
            })
            idx = endLineExcl
            continue
          }
        }
      }

      // 4. ATX Heading (`#` .. `######`)
      if (trimmed.charCodeAt(0) === 0x23 /* # */) {
        let h = 1
        while (h < trimmed.length && trimmed.charCodeAt(h) === 0x23) h++

        if (h <= 6 && (h === trimmed.length || trimmed.charCodeAt(h) === 0x20 || trimmed.charCodeAt(h) === 0x09)) {
          const headingText = trimmed
            .slice(h)
            .replace(/[ \t]+#+[ \t]*$/, "")
            .trim()
          const nextIdx = consumeTrailingBlankLines(idx + 1)
          const isTailLine = idx === lineCount - 1 && streaming
          const unresolved: string[] = []
          const used: string[] = []
          const inlines = parseInlines(headingText, this.inlineOpts(isTailLine, unresolved, used))
          const level = HEADING_LEVELS[h - 1] ?? 6
          listIndents = []
          results.push({
            start: baseOffset + lineStarts[blockStartLine]!,
            end: baseOffset + lineEnds[nextIdx - 1]!,
            raw: slice.slice(lineStarts[blockStartLine]!, lineEnds[nextIdx - 1]!),
            kind: { type: "heading", level, inlines },
            canSettle: nextIdx > idx + 1 || isLineComplete(idx),
            selfSettled: nextIdx > idx + 1 || isLineComplete(idx),
            listIndentsAfter: [],
            unresolvedRefs: unresolved,
            usedRefs: used,
          })
          idx = nextIdx
          continue
        }
      }

      // 5. Thematic break (`---`, `***`, `___`)
      if (isThematicBreak(trimmed)) {
        const nextIdx = consumeTrailingBlankLines(idx + 1)
        listIndents = []
        results.push({
          start: baseOffset + lineStarts[blockStartLine]!,
          end: baseOffset + lineEnds[nextIdx - 1]!,
          raw: slice.slice(lineStarts[blockStartLine]!, lineEnds[nextIdx - 1]!),
          kind: { type: "hr" },
          canSettle: nextIdx > idx + 1 || !streaming || (idx + 1 < lineCount && isLineComplete(idx + 1)),
          selfSettled: nextIdx > idx + 1,
          listIndentsAfter: [],
        })
        idx = nextIdx
        continue
      }

      // 6. Standalone image `![alt](src)`
      const img = matchStandaloneImage(trimmed)

      if (img) {
        const nextIdx = consumeTrailingBlankLines(idx + 1)
        const imageKind: Extract<BlockKind, { type: "image" }> = {
          type: "image",
          alt: img.alt,
          src: img.src,
        }

        if (img.title) imageKind.title = img.title
        listIndents = []
        results.push({
          start: baseOffset + lineStarts[blockStartLine]!,
          end: baseOffset + lineEnds[nextIdx - 1]!,
          raw: slice.slice(lineStarts[blockStartLine]!, lineEnds[nextIdx - 1]!),
          kind: imageKind,
          canSettle: isLineComplete(idx),
          selfSettled: isLineComplete(idx),
          listIndentsAfter: [],
        })
        idx = nextIdx
        continue
      }

      // 7. Blockquote (`> ...`)
      if (trimmed.charCodeAt(0) === 0x3e /* > */) {
        const quoteLines: string[] = []
        let k = idx

        while (k < lineCount) {
          const qTrim = getLine(k).trim()
          if (!qTrim.startsWith(">")) break
          let content = qTrim.slice(1)
          if (content.startsWith(" ")) content = content.slice(1)
          quoteLines.push(content)
          k++
        }

        const nextIdx = consumeTrailingBlankLines(k)
        const isTail = nextIdx === lineCount && streaming
        const unresolved: string[] = []
        const used: string[] = []
        const inlines = parseInlines(quoteLines.join("\n"), this.inlineOpts(isTail, unresolved, used))
        listIndents = []
        results.push({
          start: baseOffset + lineStarts[blockStartLine]!,
          end: baseOffset + lineEnds[nextIdx - 1]!,
          raw: slice.slice(lineStarts[blockStartLine]!, lineEnds[nextIdx - 1]!),
          kind: { type: "blockquote", inlines },
          canSettle: nextIdx > k || (k < lineCount && isLineComplete(k)),
          selfSettled: nextIdx > k,
          listIndentsAfter: [],
          unresolvedRefs: unresolved,
          usedRefs: used,
        })
        idx = nextIdx
        continue
      }

      // 8. GFM Pipe Table (`| h1 | h2 |\n|---|---|\n...`)
      if (
        this.options.gfm &&
        trimmed.includes("|") &&
        idx + 1 < lineCount &&
        isTableSeparator(getLine(idx + 1).trim())
      ) {
        const align = parseTableAlign(getLine(idx + 1))
        const unresolved: string[] = []
        const used: string[] = []
        const headerCells = splitTableCells(trimmed).map((cell) =>
          parseInlines(cell, this.inlineOpts(false, unresolved, used)),
        )
        const rows: InlineNode[][][] = []
        let k = idx + 2

        while (k < lineCount) {
          const rLine = getLine(k).trim()
          if (!rLine || !rLine.includes("|") || matchFenceOpen(rLine) || rLine.startsWith("#")) break
          const isLastRow = k === lineCount - 1 && streaming

          if (!isLastRow) {
            const cached = this.tableRowCache.get(rLine)

            if (cached) {
              rows.push(cached)
              k++
              continue
            }
          }

          const parsedRow = splitTableCells(rLine).map((cell) =>
            parseInlines(cell, this.inlineOpts(isLastRow, unresolved, used)),
          )

          if (!isLastRow) {
            this.tableRowCache.set(rLine, parsedRow)
          }

          rows.push(parsedRow)
          k++
        }

        const nextIdx = consumeTrailingBlankLines(k)
        const tableBlockStart = baseOffset + lineStarts[blockStartLine]!

        if (streaming && nextIdx === lineCount && nextIdx === k) {
          const lastIsCompleteLine = k > idx + 2 && slice.endsWith("\n")
          const committedCount = lastIsCompleteLine ? rows.length : Math.max(0, rows.length - 1)
          const committedEndLine = idx + 2 + committedCount

          const committedOffset =
            committedEndLine > idx + 2
              ? baseOffset + lineEnds[committedEndLine - 1]!
              : baseOffset + lineEnds[idx + 1]!

          this.activeTableState = {
            blockStart: tableBlockStart,
            committedOffset,
            align,
            headers: headerCells,
            committedRows: rows.slice(0, committedCount),
          }
        }

        listIndents = []
        results.push({
          start: tableBlockStart,
          end: baseOffset + lineEnds[nextIdx - 1]!,
          raw: slice.slice(lineStarts[blockStartLine]!, lineEnds[nextIdx - 1]!),
          kind: { type: "table", align, headers: headerCells, rows },
          canSettle: nextIdx > k || (k < lineCount && isLineComplete(k)),
          selfSettled: nextIdx > k,
          listIndentsAfter: [],
          unresolvedRefs: unresolved,
          usedRefs: used,
        })
        idx = nextIdx
        continue
      }

      // 9. List item (`- `, `* `, `1. `)
      const listMatch = matchListMarker(line)

      if (listMatch) {
        while (listIndents.length > 0 && listIndents[listIndents.length - 1]! > listMatch.indent) {
          listIndents.pop()
        }

        if (listIndents[listIndents.length - 1] !== listMatch.indent) {
          listIndents.push(listMatch.indent)
        }

        const level = Math.min(listIndents.length - 1, 4)

        let itemContent = listMatch.content
        let checked: boolean | null = null

        if (this.options.gfm) {
          if (itemContent.startsWith("[ ] ") || itemContent === "[ ]") {
            checked = false
            itemContent = itemContent.slice(3).trimStart()
          } else if (
            itemContent.startsWith("[x] ") ||
            itemContent.startsWith("[X] ") ||
            itemContent === "[x]" ||
            itemContent === "[X]"
          ) {
            checked = true
            itemContent = itemContent.slice(3).trimStart()
          }
        }

        const itemLines = [itemContent]
        let k = idx + 1

        while (k < lineCount) {
          const contLine = getLine(k)
          const contTrim = contLine.trim()

          if (contTrim.length === 0) {
            if (!this.options.flatListBlocks) {
              // Check if blank line(s) are followed by another list item or indented continuation
              let afterBlank = k + 1
              while (afterBlank < lineCount && getLine(afterBlank).trim().length === 0) afterBlank++

              if (afterBlank < lineCount) {
                const nextNonBlank = getLine(afterBlank)

                if (
                  !matchFenceOpen(nextNonBlank) &&
                  (matchListMarker(nextNonBlank) ||
                    nextNonBlank.startsWith("  ") ||
                    nextNonBlank.startsWith("\t"))
                ) {
                  itemLines.push("")
                  k = afterBlank
                  continue
                }
              }
            }

            break
          }

          const nextListMatch = matchListMarker(contLine)

          if (
            (this.options.flatListBlocks && nextListMatch) ||
            matchFenceOpen(contLine) ||
            contTrim.startsWith("#") ||
            contTrim.startsWith(">") ||
            (!nextListMatch && isThematicBreak(contTrim)) ||
            DEF_LINE_RE.test(contLine) ||
            (this.options.math && (contTrim.startsWith("$$") || contTrim.startsWith("\\["))) ||
            (this.options.gfm &&
              contTrim.includes("|") &&
              k + 1 < lineCount &&
              isTableSeparator(getLine(k + 1).trim()))
          ) {
            break
          }

          itemLines.push(contTrim)
          k++
        }

        const nextIdx = consumeTrailingBlankLines(k)
        const isTail = nextIdx === lineCount && streaming
        const unresolved: string[] = []
        const used: string[] = []
        const inlines = parseInlines(itemLines.join("\n"), this.inlineOpts(isTail, unresolved, used))

        const listKind: Extract<BlockKind, { type: "list_item" }> = {
          type: "list_item",
          ordered: listMatch.ordered,
          marker: listMatch.marker,
          level,
          inlines,
        }

        if (listMatch.start !== undefined) listKind.start = listMatch.start
        if (checked !== null) listKind.checked = checked

        results.push({
          start: baseOffset + lineStarts[blockStartLine]!,
          end: baseOffset + lineEnds[nextIdx - 1]!,
          raw: slice.slice(lineStarts[blockStartLine]!, lineEnds[nextIdx - 1]!),
          kind: listKind,
          canSettle: nextIdx > k || (k < lineCount && isLineComplete(k)),
          selfSettled: nextIdx > k,
          listIndentsAfter: [...listIndents],
          unresolvedRefs: unresolved,
          usedRefs: used,
        })
        idx = nextIdx
        continue
      }

      if (line.charCodeAt(0) !== 0x20 && line.charCodeAt(0) !== 0x09) {
        listIndents = []
      }

      // 10. Paragraph (collect lines until blank line or block opener)
      const paraLines = [line]
      let k = idx + 1
      let hitTableStart = false

      while (k < lineCount) {
        const pLine = getLine(k)
        const pTrim = pLine.trim()
        if (pTrim.length === 0) break

        if (
          matchFenceOpen(pLine) ||
          pTrim.startsWith("#") ||
          pTrim.startsWith(">") ||
          isThematicBreak(pTrim) ||
          matchListMarker(pLine) ||
          DEF_LINE_RE.test(pLine) ||
          (k + 1 < lineCount && DEF_OPEN_RE.test(pLine) && DEF_CONT_RE.test(getLine(k + 1))) ||
          matchStandaloneImage(pTrim) ||
          (this.options.math && (pTrim.startsWith("$$") || pTrim.startsWith("\\[") || pTrim === "$"))
        ) {
          break
        }

        if (this.options.gfm && pTrim.includes("|") && k + 1 < lineCount && isTableSeparator(getLine(k + 1).trim())) {
          hitTableStart = true
          break
        }

        paraLines.push(pLine)
        k++
      }

      const nextIdx = hitTableStart ? k : consumeTrailingBlankLines(k)
      const hasBlankLineAfter = nextIdx > k
      const isTail = nextIdx === lineCount && streaming && !hasBlankLineAfter
      const mightBecomeTable = paraLines.length === 1 && trimmed.includes("|") && !hasBlankLineAfter
      const unresolved: string[] = []
      const used: string[] = []
      const inlines = parseInlines(paraLines.join("\n"), this.inlineOpts(isTail, unresolved, used))

      results.push({
        start: baseOffset + lineStarts[blockStartLine]!,
        end: baseOffset + lineEnds[nextIdx - 1]!,
        raw: slice.slice(lineStarts[blockStartLine]!, lineEnds[nextIdx - 1]!),
        kind: { type: "paragraph", inlines },
        canSettle: !mightBecomeTable && (hasBlankLineAfter || (k < lineCount && isLineComplete(k))),
        selfSettled: hasBlankLineAfter,
        listIndentsAfter: [...listIndents],
        unresolvedRefs: unresolved,
        usedRefs: used,
      })
      idx = nextIdx
    }

    return results
  }

  private inlineOpts(streaming: boolean, unresolved: string[], used?: string[]): InlineParseOptions {
    return {
      gfm: this.options.gfm,
      math: this.options.math,
      streaming,
      heal: this.options.heal,
      defs: this.defs,
      onUnresolvedRef: (id) => unresolved.push(id),
      onUsedRef: used ? (id) => used.push(id) : undefined,
    }
  }
}

export function createMarkdownStream(options?: StreamOptions): PatchmarkStream {
  return new PatchmarkStream(options)
}
