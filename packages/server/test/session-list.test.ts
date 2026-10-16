import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("rejects session list filters that a cursor cannot carry", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const list = (query: string) =>
      Effect.promise(() => handler(new Request(`http://opencode.local/api/session?${query}`)))

    const responses = yield* Effect.forEach(
      [
        "directory=/repo&project=prj_test",
        "subpath=packages/core",
        "directory=/repo&subpath=packages/core",
        "project=prj_test&subpath=packages/core",
      ],
      list,
    )
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 200])
    expect(yield* Effect.promise(() => responses[0]!.json())).toMatchObject({
      message: "directory and project cannot be combined",
    })
  }).pipe(Effect.scoped),
)
