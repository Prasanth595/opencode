import { describe, expect, test } from "bun:test"
import {
  createMarkdownStream,
  healStreamingInline,
  renderBlocksToHtml,
  splitPendingMarker,
  type BlockKind,
  type MarkdownBlock,
} from "../src/index"

const CORPUS_FIXTURES = [
  [
    "# Architecture Overview",
    "",
    "Streaming Markdown sits on the hot path of every live assistant turn across **Desktop**, *Web*, and `TUI`.",
    "",
    "## Root Causes",
    "",
    "1. Full-prefix re-lexing on every non-code chunk",
    "   ```ts",
    "   export function stream(text: string, live: boolean) {",
    "     return createMarkdownStream().update(text, { streaming: live })",
    "   }",
    "   ```",
    "2. Reference link definitions at EOF: see [CommonMark Spec][spec] and [guide].",
    "",
    "| Surface | Before | After | Speedup |",
    "| --- | ---: | ---: | ---: |",
    "| Desktop | `2,621.90 ms` | `12.04 ms` | **217.8x** |",
    "| Tail p99 | `8,708 us` | `20 us` | **435x** |",
    "",
    "> Quoted note with inline math $E = mc^2$ and \\(P(x_{t+1})\\) plus $5 price.",
    "",
    "$$",
    "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
    "$$",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[Chunk] --> B[Patchmark]",
    "  B --> C[DOM Patch]",
    "```",
    "",
    "---",
    "",
    "- [x] Complete incremental block cursor",
    "- [ ] Follow-up TUI integration",
    "",
    "[spec]: https://spec.commonmark.org/",
    "   [guide]:/docs/guide",
  ].join("\n"),
  [
    "## Multi-Fence Code Synthesis",
    "",
    "```ts title=example.ts",
    "const greeting = `hello ${1 + 2}`",
    "export const list = [1, 2, 3]",
    "```",
    "",
    "~~~bash",
    "echo \"running tests\"",
    "~~~",
    "",
    "Paragraph with *foo*bar and foo*bar and *foo*bar*baz.",
  ].join("\n"),
]

describe("patchmark streaming parser", () => {
  test("preserves exact object references for settled blocks across streaming deltas", () => {
    const stream = createMarkdownStream({ renderHtml: true })
    const f1 = stream.append("# Heading\n\nFirst paragraph.\n\nSecond ")
    expect(f1.blocks.length).toBe(3)
    expect(f1.blocks[0]!.status).toBe("settled")
    expect(f1.blocks[1]!.status).toBe("settled")
    expect(f1.blocks[2]!.status).toBe("streaming")

    const b0 = f1.blocks[0]!
    const b1 = f1.blocks[1]!

    const f2 = stream.append("paragraph continues with **bold")
    expect(f2.blocks[0]).toBe(b0)
    expect(f2.blocks[1]).toBe(b1)
    expect(f2.patches).toHaveLength(1)
    expect(f2.patches[0]!.op).toBe("replace")

    const f3 = stream.finalize()
    expect(f3.blocks[0]).toBe(b0)
    expect(f3.blocks[1]).toBe(b1)
    expect(f3.blocks[2]!.status).toBe("settled")
    expect(f3.patches).toHaveLength(1)
    expect(f3.patches[0]!.op).toBe("finalize")
  })

  test("holds pending block markers until their first word arrives (zero kind-pop)", () => {
    expect(splitPendingMarker("Done.\n\n-")).toEqual({ visible: "Done.\n\n", held: "-" })
    expect(splitPendingMarker("Done.\n\n##")).toEqual({ visible: "Done.\n\n", held: "##" })
    expect(splitPendingMarker("Steps:\n\n12.")).toEqual({ visible: "Steps:\n\n", held: "12." })
    expect(splitPendingMarker("Done.\n\n---")).toEqual({ visible: "Done.\n\n---", held: "" })

    const source =
      "## What changed\n\nThe transcript grows in place.\n\n- One item.\n- Two items.\n\n1. First\n2. Second\n\n> Quoted\n\nThe end."
    const stream = createMarkdownStream()
    const kindsById = new Map<number, BlockKind["type"]>()

    for (let i = 1; i <= source.length; i++) {
      const frame = stream.update(source.slice(0, i), { streaming: i < source.length })

      for (const b of frame.blocks) {
        const prev = kindsById.get(b.id)

        if (prev !== undefined) {
          expect(b.kind.type).toBe(prev)
        }

        kindsById.set(b.id, b.kind.type)
      }
    }
  })

  test("heals incomplete emphasis, code spans, math, and links on the streaming tail", () => {
    const stream = createMarkdownStream({ renderHtml: true })
    const f1 = stream.update("Hello **world", { streaming: true })
    expect(renderBlocksToHtml(f1.blocks)).toBe("<p>Hello <strong>world</strong></p>\n")

    const f2 = stream.update("See [docs](https://example.com/gu", { streaming: true })
    expect(renderBlocksToHtml(f2.blocks)).toBe("<p>See docs</p>\n")

    const f3 = stream.update("See [docs](https://example.com/guide)", { streaming: true })
    expect(renderBlocksToHtml(f3.blocks)).toContain('href="https://example.com/guide"')

    expect(healStreamingInline("*foo*bar")).toBe("*foo*bar")
    expect(healStreamingInline("foo*bar")).toBe("foo*bar")
    expect(healStreamingInline("*foo*bar*baz")).toBe("*foo*bar*baz*")
    expect(healStreamingInline("\\(P(x_{t+1})\\)")).toBe("\\(P(x_{t+1})\\)")
    expect(healStreamingInline("\\(w^{*}\\) and *next")).toBe("\\(w^{*}\\) and *next*")
  })

  test("streams open code fences in O(|delta|) and settles when fence closes", () => {
    const stream = createMarkdownStream()
    stream.append("Intro\n\n```ts\nconst a = 1;\n")
    const beforeBlock = stream.getBlocks()[0]!
    expect(beforeBlock.status).toBe("settled")

    const f1 = stream.append("const b = 2;\n")
    expect(f1.patches).toHaveLength(1)
    expect(f1.patches[0]!.op).toBe("replace")
    expect(f1.blocks[1]!.kind).toEqual({
      type: "code",
      language: "ts",
      source: "const a = 1;\nconst b = 2;\n",
      fence: "```",
      complete: false,
    })

    stream.append("`")
    stream.append("`")
    const closed = stream.append("`\n\nAfter")
    expect(closed.blocks[1]!.status).toBe("settled")
    expect(closed.blocks[1]!.kind.type).toBe("code")

    if (closed.blocks[1]!.kind.type === "code") {
      expect(closed.blocks[1]!.kind.complete).toBe(true)
    }
  })

  test("splits list-nested code fences into standalone code blocks instead of trapping the list", () => {
    const stream = createMarkdownStream()
    const frame = stream.update(
      "1. First item\n   ```ts\n   const x = 1\n   ```\n2. Second item\n   ```ts\n   const y = 2",
      { streaming: true },
    )
    expect(frame.blocks.map((b) => [b.kind.type, b.status])).toEqual([
      ["list_item", "settled"],
      ["code", "settled"],
      ["list_item", "settled"],
      ["code", "streaming"],
    ])
  })

  test("resolves late reference link definitions via targeted patch without full-stream live fallback", () => {
    const stream = createMarkdownStream({ renderHtml: true })
    const f1 = stream.append("Read the [specification][spec].\n\nSecond paragraph.\n\n")
    expect(f1.blocks[0]!.status).toBe("settled")
    expect(f1.blocks[1]!.status).toBe("settled")

    const f2 = stream.append("[spec]: https://spec.commonmark.org/\n\n")
    expect(f2.patches.some((p) => p.op === "replace" && p.id === f1.blocks[0]!.id)).toBe(true)
    expect(renderBlocksToHtml(f2.blocks)).toContain('href="https://spec.commonmark.org/"')
  })

  test("parses inline and display math while keeping currency ($5, $10) as text", () => {
    const stream = createMarkdownStream()
    const frame = stream.update(
      "Lunch costs $5 and $10, while $A = \\pi r^2$ and \\(e^{i\\pi} + 1 = 0\\).\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n",
      { streaming: false },
    )
    expect(frame.blocks).toHaveLength(2)
    expect(frame.blocks[0]!.kind.type).toBe("paragraph")

    if (frame.blocks[0]!.kind.type === "paragraph") {
      const mathNodes = frame.blocks[0]!.kind.inlines.filter((n) => n.type === "math")
      expect(mathNodes).toEqual([
        { type: "math", source: "A = \\pi r^2", delimiter: "dollar", display: false },
        { type: "math", source: "e^{i\\pi} + 1 = 0", delimiter: "paren", display: false },
      ])
    }

    expect(frame.blocks[1]!.kind).toEqual({
      type: "math",
      source: "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
      delimiter: "double-dollar",
      complete: true,
    })
  })

  test("streams GFM pipe tables row-by-row once the separator line arrives", () => {
    const stream = createMarkdownStream()
    const f1 = stream.append("| Col A | Col B |\n")
    expect(f1.blocks[0]!.kind.type).toBe("paragraph")
    expect(f1.blocks[0]!.status).toBe("streaming")

    const f2 = stream.append("|---|---|\n| 1 | 2 |\n")
    expect(f2.blocks).toHaveLength(1)
    expect(f2.blocks[0]!.kind.type).toBe("table")

    if (f2.blocks[0]!.kind.type === "table") {
      expect(f2.blocks[0]!.kind.rows).toHaveLength(1)
    }

    const f3 = stream.append("| 3 | **four** |\n")

    if (f3.blocks[0]!.kind.type === "table") {
      expect(f3.blocks[0]!.kind.rows).toHaveLength(2)
    }
  })

  test("streaming chunk-by-chunk produces identical settled AST and HTML to one-shot parsing and reconstructs exact state from patches", () => {
    for (const text of CORPUS_FIXTURES) {
      const oneShot = createMarkdownStream({ renderHtml: true })
      const oneShotFrame = oneShot.update(text, { streaming: false })

      const streamed = createMarkdownStream({ renderHtml: true })
      const replica: MarkdownBlock[] = []

      for (let i = 0; i < text.length; i += 5) {
        const frame = streamed.append(text.slice(i, i + 5))

        for (const patch of frame.patches) {
          if (patch.op === "append") replica.push(patch.block)
          else if (patch.op === "replace" || patch.op === "finalize") replica[patch.index] = patch.block
          else if (patch.op === "truncate") replica.length = patch.keepCount
        }

        expect(replica).toEqual([...frame.blocks])
      }

      const finalFrame = streamed.finalize()

      for (const patch of finalFrame.patches) {
        if (patch.op === "append") replica.push(patch.block)
        else if (patch.op === "replace" || patch.op === "finalize") replica[patch.index] = patch.block
        else if (patch.op === "truncate") replica.length = patch.keepCount
      }

      expect(replica).toEqual([...finalFrame.blocks])
      expect(finalFrame.blocks.length).toBe(oneShotFrame.blocks.length)

      for (let i = 0; i < oneShotFrame.blocks.length; i++) {
        expect(finalFrame.blocks[i]!.kind).toEqual(oneShotFrame.blocks[i]!.kind)
        expect(finalFrame.blocks[i]!.status).toBe("settled")
      }

      expect(renderBlocksToHtml(finalFrame.blocks)).toBe(renderBlocksToHtml(oneShotFrame.blocks))
    }
  })
})
