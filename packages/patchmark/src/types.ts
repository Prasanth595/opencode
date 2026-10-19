export type MathDelimiter = "dollar" | "double-dollar" | "paren" | "bracket"

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "del"; children: InlineNode[] }
  | { type: "code"; text: string; isFilePath?: boolean; isUrl?: boolean }
  | { type: "math"; source: string; delimiter: MathDelimiter; display: boolean }
  | { type: "link"; href: string; title?: string; children: InlineNode[]; pending?: boolean }
  | { type: "image"; src: string; alt: string; title?: string }
  | { type: "br" }

export type TableAlign = "left" | "center" | "right" | null

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

export type BlockKind =
  | {
      type: "paragraph"
      inlines: InlineNode[]
    }
  | {
      type: "heading"
      level: HeadingLevel
      inlines: InlineNode[]
    }
  | {
      type: "code"
      language?: string
      meta?: string
      source: string
      fence: string
      indented?: boolean
      complete: boolean
    }
  | {
      type: "mermaid"
      source: string
      complete: boolean
    }
  | {
      type: "math"
      source: string
      delimiter: "double-dollar" | "bracket"
      complete: boolean
    }
  | {
      type: "blockquote"
      inlines: InlineNode[]
    }
  | {
      type: "list_item"
      ordered: boolean
      marker: string
      start?: number
      level: number
      checked?: boolean | null
      inlines: InlineNode[]
    }
  | {
      type: "table"
      align: TableAlign[]
      headers: InlineNode[][]
      rows: InlineNode[][][]
    }
  | {
      type: "hr"
    }
  | {
      type: "image"
      alt: string
      src: string
      title?: string
    }

export interface MarkdownBlock {
  /** Monotonic stable block ID within the stream (0, 1, 2, ...) */
  id: number
  /** Start offset in the source string (UTF-16 code units) */
  start: number
  /** End offset in the source string (UTF-16 code units) */
  end: number
  /** Raw markdown slice for this block */
  raw: string
  /** Whether this block is settled (immutable) or still actively growing at the stream tail */
  status: "streaming" | "settled"
  /** Parsed block payload and inline AST */
  kind: BlockKind
  /** Lazily or eagerly rendered HTML when requested */
  html?: string
  /** Resolved reference link definition lines attached for downstream Markdown renderers */
  defs?: string
}

export type BlockPatch =
  | { op: "append"; block: MarkdownBlock }
  | { op: "replace"; id: number; index: number; block: MarkdownBlock }
  | { op: "finalize"; id: number; index: number; block: MarkdownBlock }
  | { op: "truncate"; keepCount: number }

export interface StreamFrame {
  /** Full accumulated source text */
  text: string
  /** Byte/char offset up to which blocks are settled and will never be reparsed on append */
  settledOffset: number
  /** Current blocks array (settled prefix references are preserved identically across frames) */
  blocks: ReadonlyArray<MarkdownBlock>
  /** Minimal patch list transforming the previous frame's blocks into `blocks` */
  patches: ReadonlyArray<BlockPatch>
  /** Any trailing bare marker held back to prevent 1-frame paragraph-to-heading/list pops */
  heldMarker: string
  /** Exact number of source characters scanned during this step */
  charsScanned: number
}

export interface StreamOptions {
  /** Enable GFM tables, strikethrough, task lists, and autolinks (default: true) */
  gfm?: boolean
  /** Enable TeX math ($...$, $$...$$, \(...\), \[...\]) with Pandoc currency rules (default: true) */
  math?: boolean
  /** Repair unclosed inline syntax on the active streaming tail block (default: true) */
  heal?: boolean
  /** Hold bare trailing block markers (-, ##, 1., >) until their first word arrives (default: true) */
  holdPendingMarkers?: boolean
  /** Split top-level list items & list-indented code fences into individual blocks for O(1) list streaming (default: true) */
  flatListBlocks?: boolean
  /** Settle self-contained tail blocks (headings, closed fences, blank-line-terminated blocks) before the next block starts (default: true) */
  settleOnComplete?: boolean
  /** Eagerly populate `block.html` on each emitted block (default: false) */
  renderHtml?: boolean
}
