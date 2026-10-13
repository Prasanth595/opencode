import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AIError, LLM, LLMRequest, ToolDefinition } from "../../src/index.js"
import { GoogleVertex } from "../../src/providers.js"
import { Auth, LLMClient } from "../../src/route.js"
import * as Gemini from "../../src/protocols/gemini.js"
import { it } from "../lib/effect.js"
import { dynamicResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = Gemini.route
  .with({
    endpoint: { baseURL: "https://generativelanguage.test/v1beta/" },
    auth: Auth.header("x-goog-api-key", "test"),
  })
  .model({ id: "gemini-test" })

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Count in words.",
  generation: { maxTokens: 200_000 },
})

interface Sent {
  readonly url: string
  readonly body: Record<string, unknown>
}

// Answers the nth request with the nth SSE body and records what was sent.
const scripted = (sent: Array<Sent>, responses: ReadonlyArray<string>) =>
  dynamicResponse((input) =>
    Effect.sync(() => {
      sent.push({ url: input.request.url, body: JSON.parse(input.text) })
      return input.respond(responses[sent.length - 1], { headers: { "content-type": "text/event-stream" } })
    }),
  )

const text = (value: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ text: value, ...extra }] } }],
})

const continuation = (token: string, usageMetadata?: Record<string, number>) => ({
  candidates: [
    { content: { role: "model", parts: [{ text: "" }] }, finishReason: "CONTINUATION", continuationToken: token },
  ],
  usageMetadata,
})

describe("Gemini continuation", () => {
  it.effect("stitches a response split mid-word across two requests into one text block", () =>
    Effect.gen(function* () {
      const sent: Array<Sent> = []
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          scripted(sent, [
            sseEvents(
              text("THIRTEEN THOUSAND", { thoughtSignature: "first_sig" }),
              // Mid-stream checkpoint: a token without a finish reason must not trigger continuation.
              {
                candidates: [
                  { content: { role: "model", parts: [{ text: " TWO" }] }, continuationToken: "checkpoint" },
                ],
              },
              continuation("token_1"),
            ),
            sseEvents({
              candidates: [
                { content: { role: "model", parts: [{ text: "HUNDRED SEVENTY-TWO" }] }, finishReason: "STOP" },
              ],
            }),
          ]),
        ),
      )

      expect(sent).toHaveLength(2)
      expect(sent[0].body.continuationToken).toBeUndefined()
      expect(sent[1]).toEqual({ url: sent[0].url, body: { ...sent[0].body, continuationToken: "token_1" } })
      expect(response.text).toBe("THIRTEEN THOUSAND TWOHUNDRED SEVENTY-TWO")
      expect(response.events.map((event) => event.type)).toEqual([
        "step-start",
        "text-start",
        "text-delta",
        "text-delta",
        "text-delta",
        "text-end",
        "step-finish",
        "finish",
      ])
      expect(response.events.find((event) => event.type === "text-delta")).toMatchObject({
        id: "text-0",
        providerMetadata: { google: { thoughtSignature: "first_sig" } },
      })
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: { normalized: "stop", raw: "STOP" } })
      expect(JSON.stringify(response.events)).not.toContain("token_1")
      expect(JSON.stringify(response.events)).not.toContain("checkpoint")
    }),
  )

  it.effect("carries reasoning, text, and a later signed tool call across three requests", () =>
    Effect.gen(function* () {
      const sent: Array<Sent> = []
      const response = yield* LLMClient.generate(
        LLMRequest.update(request, {
          tools: [ToolDefinition.make({ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } })],
        }),
      ).pipe(
        Effect.provide(
          scripted(sent, [
            sseEvents(
              text("Planning the cou", { thought: true, thoughtSignature: "thought_sig" }),
              continuation("token_1"),
            ),
            sseEvents(text("nt.", { thought: true }), text("ONE TWO TH"), continuation("token_2")),
            sseEvents({
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      { text: "REE" },
                      {
                        functionCall: { id: "call_1", name: "lookup", args: { query: "four" } },
                        thoughtSignature: "tool_sig",
                      },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
            }),
          ]),
        ),
      )

      expect(sent.map((item) => item.body)).toEqual([
        sent[0].body,
        { ...sent[0].body, continuationToken: "token_1" },
        { ...sent[0].body, continuationToken: "token_2" },
      ])
      expect(response.reasoning).toBe("Planning the count.")
      expect(response.text).toBe("ONE TWO THREE")
      expect(response.events.filter((event) => event.type === "reasoning-start")).toHaveLength(1)
      expect(response.events.filter((event) => event.type === "text-start")).toHaveLength(1)
      expect(response.events.find((event) => event.type === "reasoning-end")).toEqual({
        type: "reasoning-end",
        id: "reasoning-0",
        providerMetadata: { google: { thoughtSignature: "thought_sig" } },
      })
      expect(response.toolCalls).toMatchObject([
        { id: "call_1", name: "lookup", providerMetadata: { google: { thoughtSignature: "tool_sig" } } },
      ])
      expect(response.events.filter((event) => event.type === "finish")).toHaveLength(1)
      expect(response.events.at(-1)).toMatchObject({ reason: { normalized: "tool-calls", raw: "STOP" } })
    }),
  )

  it.effect("sums billed usage across requests and reports the context the response continued from", () =>
    Effect.gen(function* () {
      const sent: Array<Sent> = []
      const usage = (prompt: number, candidates: number, cached?: number) => ({
        promptTokenCount: prompt,
        candidatesTokenCount: candidates,
        totalTokenCount: prompt + candidates,
        ...(cached === undefined ? {} : { cachedContentTokenCount: cached }),
      })
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          scripted(sent, [
            sseEvents(text("a"), continuation("token_1", usage(142, 32_768))),
            sseEvents(text("b"), continuation("token_2", usage(32_910, 32_768))),
            sseEvents(text("c"), continuation("token_3", usage(65_678, 32_768, 32_911))),
            sseEvents({
              candidates: [{ content: { role: "model", parts: [{ text: "d" }] }, finishReason: "STOP" }],
              usageMetadata: usage(98_446, 7_257, 65_679),
            }),
          ]),
        ),
      )

      expect(sent).toHaveLength(4)
      expect(response.usage).toMatchObject({
        contextTokens: 142,
        inputTokens: 197_176,
        outputTokens: 105_561,
        nonCachedInputTokens: 98_586,
        cacheReadInputTokens: 98_590,
        reasoningTokens: undefined,
        totalTokens: 302_737,
        providerMetadata: { google: usage(98_446, 7_257, 65_679) },
      })
    }),
  )

  it.effect("fails clearly when a split response omits its continuation token", () =>
    Effect.gen(function* () {
      const sent: Array<Sent> = []
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          scripted(sent, [
            sseEvents(text("partial"), {
              candidates: [{ content: { role: "model", parts: [] }, finishReason: "CONTINUATION" }],
            }),
          ]),
        ),
        Effect.flip,
      )

      expect(sent).toHaveLength(1)
      expect(error).toBeInstanceOf(AIError)
      expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
      expect(error.message).toContain("CONTINUATION without a continuation token")
    }),
  )

  it.effect("finishes with length when MAX_TOKENS carries a continuation token", () =>
    Effect.gen(function* () {
      const sent: Array<Sent> = []
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          scripted(sent, [
            sseEvents({
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "cut off" }] },
                  finishReason: "MAX_TOKENS",
                  continuationToken: "token_1",
                },
              ],
            }),
          ]),
        ),
      )

      expect(sent).toHaveLength(1)
      expect(response.events.at(-1)).toMatchObject({
        type: "finish",
        reason: { normalized: "length", raw: "MAX_TOKENS" },
      })
    }),
  )

  it.effect("continues Vertex Gemini responses with the Vertex request body", () =>
    Effect.gen(function* () {
      const sent: Array<Sent> = []
      const response = yield* LLMClient.generate(
        LLM.request({
          model: GoogleVertex.configure({ accessToken: "vertex-token", project: "vertex-project" }).model(
            "gemini-test",
          ),
          prompt: "Count in words.",
          providerOptions: { labels: { team: "test" }, serviceTier: "priority" },
        }),
      ).pipe(
        Effect.provide(
          scripted(sent, [
            sseEvents(text("ONE TH"), continuation("token_1")),
            sseEvents({
              candidates: [{ content: { role: "model", parts: [{ text: "OUSAND" }] }, finishReason: "STOP" }],
            }),
          ]),
        ),
      )

      expect(sent[0].url).toContain("/models/gemini-test:streamGenerateContent")
      expect(sent[0].body).toMatchObject({ labels: { team: "test" } })
      expect(sent[0].body.serviceTier).toBeUndefined()
      expect(sent[1]).toEqual({ url: sent[0].url, body: { ...sent[0].body, continuationToken: "token_1" } })
      expect(response.text).toBe("ONE THOUSAND")
    }),
  )
})
