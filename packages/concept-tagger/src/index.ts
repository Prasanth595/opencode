import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import { push, flush } from "./buffer.js"
import { captureBlock } from "./capture.js"
import { tag, setSmallModel, setVaultPath } from "./tag.js"

const TagTimeoutMs = 10_000

const ConceptTaggerPlugin: Plugin = async (ctx: PluginInput, options) => {
  setVaultPath(typeof options?.vault_path === "string" ? options.vault_path : undefined)
  const hooks: Hooks = {
    async config(cfg) {
      setSmallModel(cfg.small_model)
    },
    async "tool.execute.after"(input, output) {
      const block = captureBlock(input, output)
      if (block) push(input.sessionID, block)
    },
    async "experimental.text.complete"(input, output) {
      const diffContext = flush(input.sessionID)
      if (!diffContext && !output.text) return
      try {
        output.text = await Promise.race([
          tag(ctx.client, output.text, diffContext),
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error("concept-tagger timeout")), TagTimeoutMs)),
        ])
      } catch {
        // fail open: leave output.text untouched
      }
    },
  }
  return hooks
}

export default { id: "concept-tagger", server: ConceptTaggerPlugin }
