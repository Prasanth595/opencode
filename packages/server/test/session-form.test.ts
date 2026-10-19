import { expect } from "bun:test"
import { OpenCode } from "@opencode/client/promise"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("round-trips field attachments through the generated client and form API", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const client = OpenCode.make({
      baseUrl: "http://opencode.local",
      fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
        preconnect: fetch.preconnect,
      }),
    })
    yield* Effect.promise(async () => {
      const session = await client.session.create({ title: "Question" })
      const form = await client.session.form.create({
        sessionID: session.id,
        title: "Question",
        fields: [{ key: "q0", type: "string", attachments: true }],
      })
      expect(form.fields[0]).toMatchObject({ attachments: true })
      const input = { sessionID: session.id, formID: form.id }
      const attachments = { q0: [{ data: "AQID", mime: "image/png", name: "screenshot.png" }] }
      await client.session.form.reply({ ...input, answer: {}, attachments })
      expect((await client.session.form.get(input)).state).toEqual({
        status: "answered",
        answer: {},
        attachments,
      })

      const plain = await client.session.form.create({
        sessionID: session.id,
        title: "Text",
        fields: [{ key: "q0", type: "string" }],
      })
      const plainInput = { sessionID: session.id, formID: plain.id }
      await client.session.form.reply({ ...plainInput, answer: { q0: "unchanged" } })
      expect((await client.session.form.get(plainInput)).state).toEqual({
        status: "answered",
        answer: { q0: "unchanged" },
      })
    })
  }).pipe(Effect.scoped),
)
