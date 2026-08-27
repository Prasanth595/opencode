import type { SharedV3ProviderMetadata } from "@ai-sdk/provider"
import type { MetadataExtractor } from "../../github-copilot/chat/openai-compatible-metadata-extractor"

/**
 * llama.cpp server's own `/v1/chat/completions` response shape adds a
 * `timings` object next to the standard OpenAI fields — present on the
 * final chunk of a streaming response (the one carrying `finish_reason`)
 * and on the top level of a non-streaming response. Every field is
 * optional because non-llama.cpp OpenAI-compatible servers simply omit it.
 */
type LlamaCppRawTimings = {
  prompt_n?: number
  prompt_ms?: number
  prompt_per_second?: number
  predicted_n?: number
  predicted_ms?: number
  predicted_per_second?: number
}

export type LlamaCppTimings = {
  promptN: number
  promptMs: number
  promptPerSecond: number
  predictedN: number
  predictedMs: number
  predictedPerSecond: number
}

function extractTimings(body: unknown): LlamaCppTimings | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const timings = (body as { timings?: unknown }).timings
  if (typeof timings !== "object" || timings === null) return undefined
  const t = timings as LlamaCppRawTimings
  if (typeof t.predicted_ms !== "number") return undefined
  return {
    promptN: t.prompt_n ?? 0,
    promptMs: t.prompt_ms ?? 0,
    promptPerSecond: t.prompt_per_second ?? 0,
    predictedN: t.predicted_n ?? 0,
    predictedMs: t.predicted_ms,
    predictedPerSecond: t.predicted_per_second ?? 0,
  }
}

function toMetadata(timings: LlamaCppTimings | undefined): SharedV3ProviderMetadata | undefined {
  if (!timings) return undefined
  return { llamacpp: { timings } }
}

export const LlamaCppMetadataExtractor: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => toMetadata(extractTimings(parsedBody)),
  createStreamExtractor: () => {
    let latest: LlamaCppTimings | undefined
    return {
      processChunk(parsedChunk: unknown) {
        const timings = extractTimings(parsedChunk)
        if (timings) latest = timings
      },
      buildMetadata: () => toMetadata(latest),
    }
  },
}
