import {
  createMarkdownStream,
  healStreamingInline,
  type MarkdownBlock,
  type PatchmarkStream,
} from "@opencode/patchmark"
import { completedProjection } from "./markdown-projection"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live" | "code"
  language?: string
  complete?: boolean
}

export type ProjectionPatch =
  | { op: "append"; block: Block }
  | { op: "replace"; index: number; block: Block }
  | { op: "finalize"; index: number; block: Block }
  | { op: "truncate"; keepCount: number }

export type Projection = {
  text: string
  blocks: Block[]
  patches?: ProjectionPatch[]
}

const streams = new WeakMap<Projection, PatchmarkStream>()

function createStream() {
  return createMarkdownStream({
    gfm: true,
    math: true,
    heal: true,
    holdPendingMarkers: false,
    flatListBlocks: false,
    settleOnComplete: false,
    renderHtml: false,
  })
}

function toBlock(block: MarkdownBlock): Block {
  if (block.kind.type === "code") {
    const item: Block = {
      raw: block.raw,
      src: block.kind.source,
      mode: "code",
    }

    if (block.kind.language) item.language = block.kind.language

    if (block.kind.complete) item.complete = true

    return item
  }

  if (block.kind.type === "mermaid") {
    const item: Block = {
      raw: block.raw,
      src: block.kind.source,
      mode: "code",
      language: "mermaid",
    }

    if (block.kind.complete) item.complete = true

    return item
  }

  const mode = block.status === "settled" ? "full" : "live"
  const baseSrc = mode === "live" ? healStreamingInline(block.raw) : block.raw
  const src = block.defs ? `${baseSrc}\n\n${block.defs}` : baseSrc

  return {
    raw: block.raw,
    src,
    mode,
  }
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) return completedProjection(text).blocks

  const instance = createStream()
  const frame = instance.update(text, { streaming: true })

  if (frame.blocks.length === 0) {
    return [{ raw: text, src: healStreamingInline(text), mode: "live" }] satisfies Block[]
  }

  return frame.blocks.map(toBlock)
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

    const patches: ProjectionPatch[] = []

    const blocks = current.blocks.map((block, index) => {
      if (block.mode === "live") {
        const settled: Block = { raw: block.raw, src: block.raw, mode: "full" }
        patches.push({ op: "finalize", index, block: settled })

        return settled
      }

      if (block.mode === "code" && !block.complete) {
        const completed: Block = { ...block, complete: true }
        patches.push({ op: "finalize", index, block: completed })

        return completed
      }

      return block
    })

    return {
      text,
      blocks,
      patches: [...(current.patches ?? []), ...patches],
    }
  }

  if (!previous) {
    const instance = createStream()
    const frame = instance.update(text, { streaming: true })

    const blocks =
      frame.blocks.length === 0
        ? ([{ raw: text, src: healStreamingInline(text), mode: "live" }] satisfies Block[])
        : frame.blocks.map(toBlock)

    const patches: ProjectionPatch[] = blocks.map((block) => ({ op: "append", block }))
    const next: Projection = { text, blocks, patches }
    streams.set(next, instance)

    return next
  }

  if (previous.text === text) return previous

  let instance = streams.get(previous)

  if (!instance || instance.getText() !== previous.text) {
    instance = createStream()

    if (previous.text.length > 0 && text.startsWith(previous.text)) {
      instance.update(previous.text, { streaming: true })
    }
  }

  const wasFallback = instance.getBlocks().length === 0 && previous.blocks.length > 0
  const frame = instance.update(text, { streaming: true })

  if (frame.blocks.length === 0) {
    const fallbackBlock: Block = { raw: text, src: healStreamingInline(text), mode: "live" }

    const next: Projection = {
      text,
      blocks: [fallbackBlock],
      patches: [{ op: "truncate", keepCount: 0 }, { op: "append", block: fallbackBlock }],
    }

    streams.set(next, instance)

    return next
  }

  const blocks = wasFallback ? [] : [...previous.blocks]
  const patches: ProjectionPatch[] = wasFallback ? [{ op: "truncate", keepCount: 0 }] : []

  for (const patch of frame.patches) {
    if (patch.op === "append") {
      const block = toBlock(patch.block)
      blocks.push(block)
      patches.push({ op: "append", block })
    } else if (patch.op === "replace") {
      const block = toBlock(patch.block)
      blocks[patch.index] = block
      patches.push({ op: "replace", index: patch.index, block })
    } else if (patch.op === "finalize") {
      const block = toBlock(patch.block)
      blocks[patch.index] = block
      patches.push({ op: "finalize", index: patch.index, block })
    } else if (patch.op === "truncate") {
      blocks.length = patch.keepCount
      patches.push({ op: "truncate", keepCount: patch.keepCount })
    }
  }

  const next: Projection = { text, blocks, patches }
  streams.set(next, instance)

  return next
}
