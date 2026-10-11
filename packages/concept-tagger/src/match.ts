import type { PluginInput } from "@opencode-ai/plugin"
import type { ConceptEdge, ConceptNote, ConceptStatus } from "./vault.js"

export type ConceptMatch = {
  name: string
  id: string
  status: ConceptStatus
  isNew: boolean
  edges: ConceptEdge[]
}

export async function matchConcepts(
  client: PluginInput["client"],
  model: { providerID: string; modelID: string },
  names: string[],
  notes: ConceptNote[],
) {
  const aliasIndex = buildAliasIndex(notes)
  const byName = new Map<string, ConceptMatch>()
  const unresolved: string[] = []
  for (const name of names) {
    const note = aliasIndex.get(name.toLowerCase())
    if (note) byName.set(name, { name, id: note.id, status: note.status, isNew: false, edges: [] })
    else unresolved.push(name)
  }
  if (unresolved.length > 0)
    for (const match of await disambiguate(client, model, unresolved, notes)) byName.set(match.name, match)

  return names.flatMap((name) => {
    const match = byName.get(name)
    return match ? [match] : []
  })
}

function buildAliasIndex(notes: ConceptNote[]) {
  const index = new Map<string, ConceptNote>()
  for (const note of notes) {
    index.set(note.id.toLowerCase(), note)
    for (const alias of note.aliases) index.set(alias.toLowerCase(), note)
  }
  return index
}

async function disambiguate(
  client: PluginInput["client"],
  model: { providerID: string; modelID: string },
  names: string[],
  notes: ConceptNote[],
) {
  const session = await client.session.create({ throwOnError: true })
  try {
    const result = await client.session.prompt({
      path: { id: session.data.id },
      body: {
        model,
        system:
          "You match candidate technical concept names against an existing concept vault. " +
          "Do not call any tools. For each candidate, decide if it names the same concept as one " +
          "of the existing concept ids (including obvious synonyms/abbreviations), or if it is genuinely new. " +
          "For a genuinely new concept, propose up to 3 graph edges to existing concept ids using only " +
          'edge types "prerequisite-of", "related-to", "part-of". Reply with ONLY a JSON array, no prose, no ' +
          'markdown fences, shaped as: [{"name": string, "match"?: string, "edges"?: [{"type": string, "target": string}]}]. ' +
          'Omit "match" when the candidate is new.',
        tools: { "*": false },
        parts: [{ type: "text", text: JSON.stringify({ candidates: names, existing: notes.map((note) => note.id) }) }],
      },
      throwOnError: true,
    })
    const raw = result.data.parts.find((part) => part.type === "text")?.text ?? "[]"
    return parseDisambiguation(raw, names, notes)
  } finally {
    client.session.delete({ path: { id: session.data.id } }).catch(() => {})
  }
}

function parseDisambiguation(raw: string, names: string[], notes: ConceptNote[]): ConceptMatch[] {
  const byID = new Map(notes.map((note) => [note.id, note]))
  const parsed: { name: string; match?: string; edges?: { type: string; target: string }[] }[] = JSON.parse(raw)
  return names.map((name) => {
    const entry = parsed.find((candidate) => candidate.name === name)
    const matchedNote = entry?.match ? byID.get(entry.match) : undefined
    if (matchedNote) return { name, id: matchedNote.id, status: matchedNote.status, isNew: false, edges: [] }
    const edges = (entry?.edges ?? []).filter((edge): edge is ConceptEdge => isConceptEdge(edge) && byID.has(edge.target))
    return { name, id: name, status: "unlearned", isNew: true, edges }
  })
}

function isConceptEdge(edge: { type: string; target: string }): edge is ConceptEdge {
  return edge.type === "prerequisite-of" || edge.type === "related-to" || edge.type === "part-of"
}
