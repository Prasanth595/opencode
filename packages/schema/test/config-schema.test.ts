import { describe, expect, test } from "bun:test"
import { generate } from "../script/config-schema.js"

const schema = await generate()

describe("published config schema", () => {
  test("is a flat object schema with V2 descriptions", () => {
    expect(schema).not.toHaveProperty("$ref")
    expect(schema.type).toBe("object")
    expect(schema.$id).toBe("https://opencode.ai/config.json")
    expect(schema.properties.model.description).toBe("Default model to use when no session or agent model is selected")
  })

  test("resolves every internal reference", () => {
    const refs = [...JSON.stringify(schema).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)].map((match) => match[1])
    expect(refs.filter((ref) => !(ref in schema.$defs))).toEqual([])
  })

  test("accepts V2 fields and marks V1-only fields deprecated", () => {
    for (const key of ["permissions", "agents", "providers", "commands", "plugins", "update", "warming"])
      expect(schema.properties[key]).not.toHaveProperty("deprecated")
    for (const key of ["permission", "agent", "provider", "command", "plugin", "autoupdate", "snapshot"])
      expect(schema.properties[key]).toHaveProperty("deprecated", true)
  })

  test("accepts V1 shapes next to V2 shapes for shared keys", () => {
    expect(Object.keys(schema.properties.mcp.properties)).toEqual(["timeout", "servers"])
    expect(schema.properties.mcp.additionalProperties).toHaveProperty("deprecated", true)
    expect(schema.properties.compaction.properties).toHaveProperty("keep")
    expect(schema.properties.compaction.properties).toHaveProperty("reserved.deprecated", true)
    expect(schema.properties.skills.anyOf.map((item: { type: string }) => item.type)).toEqual(["array", "object"])
  })
})
