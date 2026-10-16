import { describe, expect } from "bun:test"
import { Effect, Ref, Stream } from "effect"
import { LLM, LLMEvent } from "../src/index.js"
import { Auth, LLMClient } from "../src/route.js"
import * as OpenAICompatibleChat from "../src/protocols/openai-compatible-chat.js"
import { it } from "./lib/effect.js"
import { fixedResponse } from "./lib/http.js"
import { sseEvents } from "./lib/sse.js"

// The decoder seam is `Stream.decodeText`: one stateful TextDecoder per stream,
// so a UTF-8 sequence split across arbitrary byte chunks must survive.
// https://github.com/anomalyco/opencode/issues/55968 reported storage containing
// U+FFFD after Cyrillic text was streamed from OpenAI-compatible providers.

const model = OpenAICompatibleChat.route
  .with({
    provider: "openai-compatible",
    endpoint: { baseURL: "https://api.provider.test/v1/" },
    auth: Auth.bearer("test-key"),
  })
  .model({ id: "unicode-model" })

const TEXT = "Привет, мир! 🎉 おはよう дождь"
const REASONING = "думаю про ёжика 🦔 и сёмгу"
const ARGS = JSON.stringify({ question: "правки в ревью?", options: ["да", "нет ёж"] })

const body = new TextEncoder().encode(
  sseEvents(
    {
      id: "c",
      choices: [{ delta: { role: "assistant", reasoning_content: REASONING }, finish_reason: null }],
      usage: null,
    },
    {
      id: "c",
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "question", arguments: ARGS } }] },
          finish_reason: null,
        },
      ],
      usage: null,
    },
    { id: "c", choices: [{ delta: { content: TEXT }, finish_reason: null }], usage: null },
    { id: "c", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: null },
  ),
)

const chunked = (...parts: ReadonlyArray<Uint8Array>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part))
      controller.close()
    },
  })

const everyChunk = (input: Uint8Array, size: number) => {
  const parts: Uint8Array[] = []
  for (let index = 0; index < input.length; index += size) parts.push(input.subarray(index, index + size))
  return chunked(...parts)
}

type Collected = {
  text: string
  reasoning: string
  input: unknown
}

const collect = () =>
  Effect.gen(function* () {
    const events = Array.from(
      yield* LLMClient.stream(LLM.request({ id: "req_1", model, prompt: "Say hello." })).pipe(Stream.runCollect),
    )
    return {
      text: events
        .filter(LLMEvent.is.textDelta)
        .map((event) => event.text)
        .join(""),
      reasoning: events
        .filter(LLMEvent.is.reasoningDelta)
        .map((event) => event.text)
        .join(""),
      input: events.find(LLMEvent.is.toolCall)?.input,
    } satisfies Collected
  })

const expectCollected = (result: Collected, label: string) => {
  expect(result.text, `${label} text`).toBe(TEXT)
  expect(result.reasoning, `${label} reasoning`).toBe(REASONING)
  expect(result.input, `${label} tool input`).toEqual(JSON.parse(ARGS))
}

const indexOfBytes = (input: Uint8Array, needle: Uint8Array) => {
  for (let start = 0; start <= input.length - needle.length; start++) {
    if (needle.every((byte, offset) => input[start + offset] === byte)) return start
  }
  return -1
}

// The same events with CRLF terminators, which the SSE spec permits.
const crlfBody = new TextEncoder().encode(new TextDecoder().decode(body).replaceAll("\n", "\r\n"))

describe("streaming multibyte UTF-8", () => {
  it.effect("decodes a response delivered as a single chunk", () =>
    collect().pipe(
      Effect.provide(fixedResponse(chunked(body))),
      Effect.map((result) => expectCollected(result, "single")),
    ),
  )

  it.effect("decodes a response delivered one byte per chunk", () =>
    collect().pipe(
      Effect.provide(fixedResponse(everyChunk(body, 1))),
      Effect.map((result) => expectCollected(result, "1-byte")),
    ),
  )

  it.effect("decodes a response delivered two bytes per chunk", () =>
    collect().pipe(
      Effect.provide(fixedResponse(everyChunk(body, 2))),
      Effect.map((result) => expectCollected(result, "2-byte")),
    ),
  )

  it.effect("decodes a response delivered three bytes per chunk", () =>
    collect().pipe(
      Effect.provide(fixedResponse(everyChunk(body, 3))),
      Effect.map((result) => expectCollected(result, "3-byte")),
    ),
  )

  it.effect("decodes for every possible two-way split of the response", () =>
    Effect.forEach(
      Array.from({ length: body.length - 1 }, (_, index) => index + 1),
      (split) =>
        collect().pipe(
          Effect.provide(fixedResponse(chunked(body.subarray(0, split), body.subarray(split)))),
          Effect.map((result) => expectCollected(result, `split at byte ${split}`)),
        ),
      { concurrency: 1 },
    ),
  )

  it.effect("decodes with CRLF event terminators cut into single bytes", () =>
    collect().pipe(
      Effect.provide(fixedResponse(everyChunk(crlfBody, 1))),
      Effect.map((result) => expectCollected(result, "crlf")),
    ),
  )

  it.effect("rejects an event cut mid-character at EOF instead of fabricating U+FFFD", () => {
    const encoded = new TextEncoder().encode(
      sseEvents({ id: "c", choices: [{ delta: { content: "дождь 🎉" }, finish_reason: null }], usage: null }),
    )
    const emoji = new TextEncoder().encode("🎉")
    const start = indexOfBytes(encoded, emoji)
    expect(start).toBeGreaterThan(-1)
    // Keep the first two bytes of the four-byte emoji. The decoder must hold
    // them pending, and the truncated event must never surface as content.
    const cut = encoded.subarray(0, start + 2)
    return Effect.gen(function* () {
      const text = yield* Ref.make("")
      const error = yield* LLMClient.stream(LLM.request({ id: "req_1", model, prompt: "Say hello." })).pipe(
        Stream.tap((event) =>
          LLMEvent.is.textDelta(event) ? Ref.update(text, (value) => value + event.text) : Effect.void,
        ),
        Stream.runCollect,
        Effect.provide(fixedResponse(everyChunk(cut, 1))),
        Effect.flip,
      )
      expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput", classification: "incomplete-stream" })
      expect(yield* Ref.get(text)).toBe("")
    })
  })
})
