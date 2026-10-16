/** Construct a bounded preview that preserves both setup output and final diagnostics. */
export const headTail = (text: string, maxLines: number, maxBytes: number, location: string) => {
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf8") <= maxBytes) return undefined
  if (maxLines < 3 || maxBytes < 512) return undefined

  const head: string[] = []
  const tail: string[] = []
  const overhead = Buffer.byteLength(`\n[showing lines 1-000000 and 000000-000000 of ${lines.length}; full output saved to ${location}]`, "utf8")
  const budget = maxBytes - overhead
  if (budget <= 0) return undefined
  const firstBytes = Math.floor(budget * 0.6)
  const firstLines = Math.max(1, Math.floor((maxLines - 1) * 0.6))
  let used = 0
  for (const line of lines) {
    if (head.length >= firstLines) break
    const bytes = Buffer.byteLength(line, "utf8") + 1
    if (used + bytes > firstBytes) break
    head.push(line)
    used += bytes
  }
  let remaining = budget - used
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (head.length + tail.length >= maxLines - 1) break
    const bytes = Buffer.byteLength(lines[i]!, "utf8") + 1
    if (bytes > remaining) break
    tail.unshift(lines[i]!)
    remaining -= bytes
  }
  // Keeping only one side is no better than the existing prefix truncation.
  if (!head.length || !tail.length) return undefined
  const start = lines.length - tail.length + 1
  const marker = `[showing lines 1-${head.length} and ${start}-${lines.length} of ${lines.length}; full output saved to ${location}]`
  const preview = `${head.join("\n")}\n${marker}\n${tail.join("\n")}`
  if (Buffer.byteLength(preview, "utf8") > maxBytes) return undefined
  return preview
}
