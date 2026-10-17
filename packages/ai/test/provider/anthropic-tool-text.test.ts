import { expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart, CacheHint } from "../../src/index.js"
import { Media } from "../../src/media.js"
import { protocol, route } from "../../src/protocols/anthropic-messages.js"

const payload = "# Notes\n\nCafé 日本語 — +patch\n"
const lower = (messages: Parameters<typeof LLM.request>[0]["messages"]) =>
  Effect.runPromise(
    protocol.body.from(
      LLM.request({
        model: route.model({ id: "fixture" }),
        messages,
        cache: "none",
      }),
    ),
  )
const history = (mime: string, uri: string) => [
  Message.assistant([ToolCallPart.make({ id: "call_attachment", name: "execute", input: {} })]),
  Message.tool({
    id: "call_attachment",
    name: "execute",
    resultType: "content",
    result: [
      { type: "text", text: "Attachment downloaded" },
      { type: "file", mime, name: "fixture.md", uri },
    ],
  }),
]
for (const mime of ["text/markdown", "text/x-patch", "TEXT/MARKDOWN"]) {
  for (const representation of ["dataURL", "rawBase64", "unpaddedBase64"]) {
    test(`preserves ${mime} tool attachment text from ${representation} across followups`, async () => {
      const encoded = Buffer.from(payload).toString("base64")
      const messages = history(
        mime,
        representation === "dataURL"
          ? `data:application/octet-stream;base64,${encoded}`
          : representation === "unpaddedBase64"
            ? encoded.replace(/=+$/, "")
            : encoded,
      )
      const stored = JSON.stringify(messages)
      for (const turn of [messages, [...messages, Message.user("Unrelated followup")]]) {
        const body = await lower(turn)
        const result = body.messages.flatMap((message) => message.content).find((part) => part.type === "tool_result")
        expect(result).toMatchObject({
          content: [
            { type: "text", text: "Attachment downloaded" },
            {
              type: "document",
              title: "fixture.md",
              source: { type: "text", media_type: "text/plain", data: payload },
            },
          ],
        })
      }
      expect(JSON.stringify(messages)).toBe(stored)
    })
  }
}
for (const [mime, uri, reason] of [
  ["text/markdown", "data:text/markdown,%23%20Notes", "does not support media type text/markdown"],
  ["text/markdown", "https://example.test/notes.md", "requires inline media"],
  ["application/octet-stream", "AAEC", "does not support media type application/octet-stream"],
  ["text/markdown", "/w==", "does not support media type text/markdown"],
  [
    "text/markdown",
    `data:text/markdown;charset=utf-16le;base64,${Buffer.from("Hello", "utf16le").toString("base64")}`,
    "does not support media type text/markdown",
  ],
  [
    "text/markdown; charset=utf-16le",
    Buffer.from("Hello", "utf16le").toString("base64"),
    "does not support media type text/markdown; charset=utf-16le",
  ],
  ["text/x-patch", "data:text/x-patch;base64,wyg=", "does not support media type text/x-patch"],
  ["text/markdown", "%%%not-base64", "does not support media type text/markdown"],
  ["text/markdown", "SGVsbG8===", "does not support media type text/markdown"],
  ["text/markdown", "data:text/markdown;base64,SGVsbG8==", "does not support media type text/markdown"],
  ["text/markdown", "Zh==", "does not support media type text/markdown"],
]) {
  test(`retains typed rejection for ${uri}`, async () => {
    const messages = history(mime!, uri!)
    const stored = JSON.stringify(messages)
    const result = await Effect.runPromise(
      Effect.result(
        protocol.body.from(
          LLM.request({
            model: route.model({ id: "fixture" }),
            messages,
            cache: "none",
          }),
        ),
      ),
    )
    expect(result._tag).toBe("Failure")
    expect(JSON.stringify(result)).toContain(reason!)
    expect(JSON.stringify(messages)).toBe(stored)
  })
}
for (const mime of ["text/plain", "application/pdf", "image/png"]) {
  test(`retains supported ${mime} tool attachments`, async () => {
    const messages = history(mime, `data:${mime};base64,${Buffer.from(payload).toString("base64")}`)
    const stored = JSON.stringify(messages)
    const body = await lower(messages)
    const result = body.messages.flatMap((message) => message.content).find((part) => part.type === "tool_result")
    expect(result).toMatchObject({ content: [{ type: "text" }, { type: mime === "image/png" ? "image" : "document" }] })
    expect(JSON.stringify(messages)).toBe(stored)
  })
}

test("preserves top-level Anthropic file metadata without normalizing its MIME", async () => {
  const messages = [
    Message.user([
      Message.media(Media.base64("AAEC", "text/markdown"), {
        filename: "fallback.md",
        cache: new CacheHint({ type: "ephemeral" }),
        metadata: {
          anthropic: {
            file_id: "file_fixture",
            title: "Original title",
            context: "Original context",
            citations: { enabled: true },
          },
        },
      }),
    ]),
  ]
  const stored = JSON.stringify(messages)
  const body = await lower(messages)
  expect(body.messages[0]?.content[0]).toMatchObject({
    type: "document",
    source: { type: "file", file_id: "file_fixture" },
    title: "Original title",
    context: "Original context",
    citations: { enabled: true },
    cache_control: { type: "ephemeral" },
  })
  expect(JSON.stringify(messages)).toBe(stored)
})

test("does not normalize unsupported top-level text media", async () => {
  const messages = [Message.user([Message.media(Media.base64("AAEC", "text/markdown"))])]
  const result = await Effect.runPromise(
    Effect.result(
      protocol.body.from(
        LLM.request({
          model: route.model({ id: "fixture" }),
          messages,
          cache: "none",
        }),
      ),
    ),
  )
  expect(result._tag).toBe("Failure")
  expect(JSON.stringify(result)).toContain("does not support media type text/markdown")
})
