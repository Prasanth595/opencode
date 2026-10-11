import matter from "gray-matter"

export type ConceptStatus = "unlearned" | "learned" | "muted" | "snoozed"

export type ConceptEdge = { type: "prerequisite-of" | "related-to" | "part-of"; target: string }

export type ConceptNote = {
  id: string
  status: ConceptStatus
  aliases: string[]
}

export async function loadIndex(vaultPath: string) {
  const notes: ConceptNote[] = []
  for await (const filename of new Bun.Glob("*.md").scan({ cwd: vaultPath })) {
    const parsed = matter(await Bun.file(`${vaultPath}/${filename}`).text())
    notes.push({
      id: filename.replace(/\.md$/, ""),
      status: toStatus(parsed.data.status),
      aliases: toAliases(parsed.data.aliases),
    })
  }
  return notes
}

function toStatus(value: unknown): ConceptStatus {
  if (value === "unlearned" || value === "learned" || value === "muted" || value === "snoozed") return value
  return "unlearned"
}

function toAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

export async function createNote(vaultPath: string, note: { id: string; aliases: string[]; edges: ConceptEdge[] }) {
  const path = notePath(vaultPath, note.id)
  if (await Bun.file(path).exists()) return
  const body = note.edges.map((edge) => `- ${edge.type} [[${edge.target}]]`).join("\n")
  await Bun.write(path, matter.stringify(body ? `\n${body}\n` : "\n", { status: "unlearned", aliases: note.aliases }))
}

export async function setStatus(vaultPath: string, id: string, status: ConceptStatus) {
  const path = notePath(vaultPath, id)
  const parsed = matter(await Bun.file(path).text())
  parsed.data.status = status
  if (status === "learned") parsed.data.learned_date = new Date().toISOString().slice(0, 10)
  await Bun.write(path, matter.stringify(parsed.content, parsed.data))
}

// Obsidian uses the filename as the note title; keep it filesystem-safe without
// touching the canonical id used for alias/exact matching elsewhere.
function notePath(vaultPath: string, id: string) {
  return `${vaultPath}/${id.replace(/[/\\:*?"<>|]/g, "-")}.md`
}
