import type { PluginInput } from "@opencode-ai/plugin"
import { matchConcepts, type ConceptMatch } from "./match.js"
import { createNote, loadIndex } from "./vault.js"

const MARKER = { open: (match: ConceptMatch) => `[[concept:${match.id}:${match.status}]]`, close: "[[/concept]]" }

let smallModel: { providerID: string; modelID: string } | undefined
let vaultPath: string | undefined

export function setSmallModel(spec: string | undefined) {
  if (!spec) return
  const [providerID, ...rest] = spec.split("/")
  if (providerID && rest.length) smallModel = { providerID, modelID: rest.join("/") }
}

export function setVaultPath(path: string | undefined) {
  vaultPath = path
}

export async function tag(client: PluginInput["client"], text: string, diffContext: string) {
  const model = smallModel ?? { providerID: "opencode", modelID: "claude-haiku-4-5" }
  const names = await extractConcepts(client, model, text, diffContext)
  const matches = await resolveConcepts(client, model, names)
  return applyMarkers(text, matches)
}

async function extractConcepts(client: PluginInput["client"], model: { providerID: string; modelID: string }, text: string, diffContext: string) {
  const session = await client.session.create({ throwOnError: true })
  try {
    const result = await client.session.prompt({
      path: { id: session.data.id },
      body: {
        model,
        system:
          "You extract notable technical concepts from text. Do not call any tools. " +
          "Reply with ONLY a JSON array of short concept name strings that literally appear " +
          "(verbatim substrings) in the input. No prose, no markdown fences.",
        tools: { "*": false },
        parts: [{ type: "text", text: `${text}\n\n---\n${diffContext}` }],
      },
      throwOnError: true,
    })
    const raw = result.data.parts.find((part) => part.type === "text")?.text ?? "[]"
    return JSON.parse(raw) as string[]
  } finally {
    client.session.delete({ path: { id: session.data.id } }).catch(() => {})
  }
}

async function resolveConcepts(client: PluginInput["client"], model: { providerID: string; modelID: string }, names: string[]) {
  if (!vaultPath) return names.map((name) => ({ name, id: name, status: "unlearned", isNew: true, edges: [] }) satisfies ConceptMatch)
  const notes = await loadIndex(vaultPath)
  const matches = await matchConcepts(client, model, names, notes)
  await persistNewConcepts(vaultPath, matches)
  return matches
}

// Creating the note as soon as a concept is first seen lets later mentions resolve
// against it by alias/exact match instead of paying for disambiguation again.
async function persistNewConcepts(vaultPath: string, matches: ConceptMatch[]) {
  const seen = new Set<string>()
  for (const match of matches) {
    if (!match.isNew || seen.has(match.id)) continue
    seen.add(match.id)
    await createNote(vaultPath, { id: match.id, aliases: [match.name], edges: match.edges })
  }
}

function applyMarkers(text: string, matches: ConceptMatch[]) {
  return matches.reduce((tagged, match) => {
    if (!match.name) return tagged
    const idx = tagged.toLowerCase().indexOf(match.name.toLowerCase())
    if (idx === -1) return tagged
    return tagged.slice(0, idx) + MARKER.open(match) + tagged.slice(idx, idx + match.name.length) + MARKER.close + tagged.slice(idx + match.name.length)
  }, text)
}
