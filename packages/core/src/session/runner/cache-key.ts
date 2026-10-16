import { createHash } from "node:crypto"

/** One-off prompts must not evict the primary conversation's prompt-cache prefix. */
export const promptCacheKey = (affinity: string, kind: string): string => {
  const base = /^ses_[0-9a-f]{64}$/.test(affinity) ? affinity.slice(4) : affinity
  return kind === "primary" ? base : createHash("sha256").update(base).update("\0").update(kind).digest("hex")
}
