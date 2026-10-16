import { createHash } from "node:crypto"
import { Message } from "@opencode/ai"

/** Request-only deduplication: persisted tool outputs and the latest observation stay intact. */
export const dedupe = (messages: readonly Message[]): Message[] => {
  if (process.env.OPENCODE_TOKEN_ECONOMY === "0") return [...messages]
  const seen = new Map<string, string>()
  const output = [...messages]
  const allowed = new Set(["read", "grep", "glob", "webfetch"])
  for (let index = output.length - 1; index >= 0; index--) {
    const message = output[index]!
    if (message.role !== "tool") continue
    const content = message.content.map((part) => {
      if (part.type !== "tool-result" || !allowed.has(part.name) || part.providerExecuted || part.providerMetadata)
        return part
      if (part.result.type !== "text" || typeof part.result.value !== "string" || part.result.value.length < 2048) return part
      const digest = createHash("sha256").update(part.name).update("\0").update(part.result.value).digest("hex")
      const latest = seen.get(digest)
      if (latest === undefined) {
        seen.set(digest, part.id)
        return part
      }
      return { ...part, result: { type: "text" as const, value: `[Identical ${part.name} output omitted; see later tool result ${latest}.]` } }
    })
    if (content.some((part, i) => part !== message.content[i]))
      output[index] = new Message({ ...message, content })
  }
  return output
}
