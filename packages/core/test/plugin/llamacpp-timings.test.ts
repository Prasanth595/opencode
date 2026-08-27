import { describe, expect, test } from "bun:test"
import { LlamaCppMetadataExtractor } from "@opencode-ai/core/plugin/provider/llamacpp-timings"

const rawTimings = {
  prompt_n: 16,
  prompt_ms: 307.965,
  prompt_per_second: 51.96,
  predicted_n: 42,
  predicted_ms: 900.12,
  predicted_per_second: 46.66,
}

describe("LlamaCppMetadataExtractor", () => {
  test("extracts timings from a non-streaming response body", async () => {
    const metadata = await LlamaCppMetadataExtractor.extractMetadata({
      parsedBody: { choices: [], timings: rawTimings },
    })
    expect(metadata).toEqual({
      llamacpp: {
        timings: {
          promptN: 16,
          promptMs: 307.965,
          promptPerSecond: 51.96,
          predictedN: 42,
          predictedMs: 900.12,
          predictedPerSecond: 46.66,
        },
      },
    })
  })

  test("returns undefined when no timings are present", async () => {
    const metadata = await LlamaCppMetadataExtractor.extractMetadata({ parsedBody: { choices: [] } })
    expect(metadata).toBeUndefined()
  })

  test("streaming: keeps the timings from the final chunk that carries them", () => {
    const extractor = LlamaCppMetadataExtractor.createStreamExtractor()
    extractor.processChunk({ choices: [{ delta: { role: "assistant" } }] })
    extractor.processChunk({ choices: [{ delta: { content: "hi" } }] })
    extractor.processChunk({
      choices: [{ delta: {}, finish_reason: "stop" }],
      timings: rawTimings,
    })
    expect(extractor.buildMetadata()).toEqual({
      llamacpp: {
        timings: {
          promptN: 16,
          promptMs: 307.965,
          promptPerSecond: 51.96,
          predictedN: 42,
          predictedMs: 900.12,
          predictedPerSecond: 46.66,
        },
      },
    })
  })

  test("streaming: builds undefined metadata when no chunk carries timings", () => {
    const extractor = LlamaCppMetadataExtractor.createStreamExtractor()
    extractor.processChunk({ choices: [{ delta: { content: "hi" } }] })
    expect(extractor.buildMetadata()).toBeUndefined()
  })
})
