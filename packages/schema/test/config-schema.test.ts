import { describe, expect, test } from "bun:test"
import { Ajv2020 } from "ajv/dist/2020.js"
import { generate } from "../script/config-schema.js"

const schema = await generate()
const ajv = new Ajv2020({ strict: false, allErrors: true })
// The frozen V1 schema references the models.dev catalog for legacy model fields.
ajv.addSchema({ $id: "https://models.dev/model-schema.json", $defs: { Model: { type: "string" } } })
const validate = ajv.compile(schema)
const valid = (config: unknown) => {
  const result = validate(config)
  if (!result) console.error(validate.errors)
  return result
}

describe("published config schema", () => {
  test("is a flat object schema with V2 descriptions", () => {
    expect(schema).not.toHaveProperty("$ref")
    expect(schema.type).toBe("object")
    expect(schema.$id).toBe("https://opencode.ai/config.json")
    expect(schema.properties.update.description).toBeString()
    expect(schema.properties.model.description).toBe("Default model to use when no session or agent model is selected")
  })

  test("accepts V2 configuration", () => {
    expect(
      valid({
        $schema: "https://opencode.ai/config.json",
        model: "anthropic/claude-sonnet-4-5",
        update: "notify",
        snapshots: false,
        permissions: [{ action: "shell", resource: "git push *", effect: "ask" }],
        policies: [{ action: "tool.use", resource: "shell:git push *", effect: "deny" }],
        agents: { reviewer: { mode: "subagent", system: "Review", permissions: [] } },
        commands: { review: { template: "Review the diff" } },
        plugins: ["opencode-example-plugin", { package: "./plugins/local", options: { enabled: true } }],
        skills: ["./team-skills"],
        mcp: {
          timeout: { startup: 45000 },
          servers: {
            playwright: { type: "local", command: ["bunx", "@playwright/mcp"], disabled: true },
            docs: { type: "remote", url: "https://example.com/mcp", oauth: { client_id: "id" } },
          },
        },
        compaction: { auto: true, keep: { tokens: 15000 }, buffer: 20000 },
        warming: true,
        worktree: { directory: "../worktrees" },
        providers: {
          internal: {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: "http://127.0.0.1:8000/v1" },
            models: { "Qwen/Qwen3-Coder": { variants: [{ id: "high", settings: { reasoningEffort: "high" } }] } },
          },
        },
        experimental: { subagent_depth: 2 },
      }),
    ).toBe(true)
  })

  test("accepts V1 configuration with its fields marked deprecated", () => {
    expect(
      valid({
        autoupdate: "notify",
        snapshot: true,
        permission: { bash: { "git push *": "ask" } },
        agent: { reviewer: { mode: "subagent", prompt: "Review" } },
        command: { review: { template: "Review the diff" } },
        plugin: ["opencode-example-plugin"],
        provider: { openai: { options: { timeout: 600000 } } },
        skills: { paths: ["./team-skills"] },
        mcp: { playwright: { type: "local", command: ["bunx", "@playwright/mcp"], enabled: false } },
        compaction: { reserved: 20000 },
        experimental: { mcp_timeout: 10000 },
        model: "anthropic/claude-sonnet-4-5",
        small_model: "anthropic/claude-haiku-4-5",
        formatter: { prettier: { command: ["prettier", "--write", "$FILE"], extensions: [".ts"] } },
        lsp: { typescript: { disabled: true } },
        reference: { docs: "../docs" },
      }),
    ).toBe(true)
    for (const key of ["autoupdate", "snapshot", "permission", "agent", "command", "plugin", "provider"])
      expect(schema.properties[key]).toHaveProperty("deprecated", true)
    expect(schema.properties.permissions).not.toHaveProperty("deprecated")
  })

  test("accepts V1 MCP servers next to V2 servers", () => {
    expect(
      valid({
        mcp: {
          servers: { docs: { type: "remote", url: "https://example.com/mcp" } },
          legacy: { type: "remote", url: "https://example.com/legacy" },
        },
      }),
    ).toBe(true)
  })

  test("rejects unknown fields and invalid V2 values", () => {
    expect(validate({ unknown: true })).toBe(false)
    expect(validate({ update: "always" })).toBe(false)
    expect(validate({ mcp: { servers: { docs: { type: "remote" } } } })).toBe(false)
  })
})
