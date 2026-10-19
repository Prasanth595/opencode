import type { BlockKind, InlineNode, MarkdownBlock } from "./types"

export function escapeHtml(text: string): string {
  if (!/[&<>"']/.test(text)) return text

  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function renderInlinesToHtml(nodes: ReadonlyArray<InlineNode>): string {
  let out = ""

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!

    switch (node.type) {
      case "text":
        out += escapeHtml(node.text)
        break
      case "strong":
        out += `<strong>${renderInlinesToHtml(node.children)}</strong>`
        break
      case "em":
        out += `<em>${renderInlinesToHtml(node.children)}</em>`
        break
      case "del":
        out += `<del>${renderInlinesToHtml(node.children)}</del>`
        break
      case "code": {
        const kindAttr = node.isUrl
          ? ` data-inline-code-kind="url"`
          : node.isFilePath
            ? ` data-inline-code-kind="path"`
            : ""

        out += `<code${kindAttr}>${escapeHtml(node.text)}</code>`
        break
      }
      case "math":
        out += `<span class="math-${node.display ? "display" : "inline"}" data-math-delimiter="${node.delimiter}">${escapeHtml(node.source)}</span>`
        break
      case "link": {
        const titleAttr = node.title ? ` title="${escapeHtml(node.title)}"` : ""
        out += `<a href="${escapeHtml(node.href)}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${renderInlinesToHtml(node.children)}</a>`
        break
      }
      case "image": {
        const titleAttr = node.title ? ` title="${escapeHtml(node.title)}"` : ""
        out += `<img src="${escapeHtml(node.src)}" alt="${escapeHtml(node.alt)}"${titleAttr}>`
        break
      }
      case "br":
        out += "<br>\n"
        break
    }
  }

  return out
}

const tableRowHtmlCache = new WeakMap<InlineNode[][], string>()

export function renderBlockKindToHtml(kind: BlockKind): string {
  switch (kind.type) {
    case "paragraph":
      return `<p>${renderInlinesToHtml(kind.inlines)}</p>\n`
    case "heading":
      return `<h${kind.level}>${renderInlinesToHtml(kind.inlines)}</h${kind.level}>\n`
    case "code": {
      const langClass = kind.language ? ` class="language-${escapeHtml(kind.language)}"` : ""

      return `<pre><code${langClass}>${escapeHtml(kind.source)}</code></pre>\n`
    }
    case "mermaid":
      return `<pre><code class="language-mermaid">${escapeHtml(kind.source)}</code></pre>\n`
    case "math":
      return `<div class="math-block" data-math-delimiter="${kind.delimiter}">${escapeHtml(kind.source)}</div>\n`
    case "blockquote":
      return `<blockquote>\n<p>${renderInlinesToHtml(kind.inlines)}</p>\n</blockquote>\n`
    case "list_item": {
      const tag = kind.ordered ? "ol" : "ul"
      const startAttr = kind.ordered && kind.start !== undefined && kind.start !== 1 ? ` start="${kind.start}"` : ""

      const checkbox =
        kind.checked === true
          ? `<input checked="" disabled="" type="checkbox"> `
          : kind.checked === false
            ? `<input disabled="" type="checkbox"> `
            : ""

      return `<${tag}${startAttr} data-list-level="${kind.level}">\n<li>${checkbox}${renderInlinesToHtml(kind.inlines)}</li>\n</${tag}>\n`
    }
    case "table": {
      let thead = "<thead>\n<tr>\n"

      for (let c = 0; c < kind.headers.length; c++) {
        const align = kind.align[c]
        const alignAttr = align ? ` align="${align}"` : ""
        thead += `<th${alignAttr}>${renderInlinesToHtml(kind.headers[c]!)}</th>\n`
      }

      thead += "</tr>\n</thead>"
      let tbody = ""

      if (kind.rows.length > 0) {
        tbody = "\n<tbody>\n"

        for (let r = 0; r < kind.rows.length; r++) {
          const row = kind.rows[r]!
          let rowHtml = tableRowHtmlCache.get(row)

          if (!rowHtml) {
            rowHtml = "<tr>\n"

            for (let c = 0; c < kind.headers.length; c++) {
              const align = kind.align[c]
              const alignAttr = align ? ` align="${align}"` : ""
              rowHtml += `<td${alignAttr}>${renderInlinesToHtml(row[c] ?? [])}</td>\n`
            }

            rowHtml += "</tr>\n"
            tableRowHtmlCache.set(row, rowHtml)
          }

          tbody += rowHtml
        }

        tbody += "</tbody>"
      }

      return `<table>\n${thead}${tbody}\n</table>\n`
    }
    case "hr":
      return "<hr>\n"
    case "image": {
      const titleAttr = kind.title ? ` title="${escapeHtml(kind.title)}"` : ""

      return `<p><img src="${escapeHtml(kind.src)}" alt="${escapeHtml(kind.alt)}"${titleAttr}></p>\n`
    }
  }
}

export function renderBlocksToHtml(blocks: ReadonlyArray<MarkdownBlock>): string {
  let out = ""

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    out += b.html ?? renderBlockKindToHtml(b.kind)
  }

  return out
}
