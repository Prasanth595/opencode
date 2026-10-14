import { Schema } from "effect"
import { Config } from "../src/config.js"

export const SchemaURL = "https://opencode.ai/config.json"

interface JsonSchema {
  readonly [key: string]: unknown
  readonly type?: unknown
  readonly description?: unknown
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly additionalProperties?: unknown
}

// V1 and V2 read the same opencode.json, and V2 normalizes V1 fields at load time, so the published schema accepts
// both. The V2 shape is generated from Config.Info; V1 is frozen in config-v1.json, the last schema the V1 runtime
// published. Fields only V1 understands are marked deprecated.
export async function generate() {
  const legacy: { $defs: Record<string, JsonSchema> } = await Bun.file(
    new URL("./config-v1.json", import.meta.url),
  ).json()
  const document = Schema.toJsonSchemaDocument(Config.Info, { onExcessProperty: "error" })
  const name = String(document.schema.$ref).replace("#/$defs/", "")
  const { [name]: current, ...definitions } = document.definitions as Record<string, JsonSchema>
  const { Config: previous, ...legacyDefinitions } = legacy.$defs
  if (JSON.stringify(definitions).includes(`"#/$defs/${name}"`)) throw new Error(`${name} must not reference itself`)

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SchemaURL,
    type: "object",
    properties: merge(current.properties ?? {}, previous.properties ?? {}),
    additionalProperties: false,
    $defs: mergeDefinitions(definitions, legacyDefinitions),
    allowComments: true,
    allowTrailingCommas: true,
  }
}

function merge(current: Readonly<Record<string, JsonSchema>>, previous: Readonly<Record<string, JsonSchema>>) {
  return Object.fromEntries([
    ...Object.entries(current).map(([key, schema]) => [key, previous[key] ? combine(schema, previous[key]) : schema]),
    ...Object.entries(previous)
      .filter(([key]) => !current[key])
      .map(([key, schema]) => [key, { ...schema, deprecated: true }]),
  ])
}

// Shared keys keep the V2 shape. Objects whose V1 properties V2 still normalizes (mcp, compaction, experimental)
// accept both property sets, and keys whose type changed (skills) accept either shape.
function combine(current: JsonSchema, previous: JsonSchema): JsonSchema {
  const description = current.description ?? previous.description
  if (current.type === "object" && previous.type === "object")
    return {
      ...current,
      description,
      properties: merge(current.properties ?? {}, previous.properties ?? {}),
      additionalProperties:
        typeof current.additionalProperties === "object" || typeof previous.additionalProperties !== "object"
          ? current.additionalProperties
          : { ...previous.additionalProperties, deprecated: true },
    }
  if (current.type !== undefined && previous.type !== undefined && current.type !== previous.type)
    return { description, anyOf: [current, { ...previous, deprecated: true }] }
  return { ...current, description }
}

function mergeDefinitions(current: Record<string, JsonSchema>, previous: Record<string, JsonSchema>) {
  const conflicts = Object.keys(previous).filter(
    (key) => current[key] && JSON.stringify(current[key]) !== JSON.stringify(previous[key]),
  )
  if (conflicts.length) throw new Error(`Conflicting V1 and V2 schema definitions: ${conflicts.join(", ")}`)
  return { ...previous, ...current }
}

if (import.meta.main) {
  const target = process.argv[2]
  if (!target) throw new Error("A schema output path is required")
  await Bun.write(target, JSON.stringify(await generate(), null, 2) + "\n")
}
