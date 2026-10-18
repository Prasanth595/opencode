import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live(
  "removing an unknown shell reports not found instead of succeeding silently",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const server = yield* startServer(tmp.path)
      const request = (method: string, id: string) => {
        const url = new URL(`/api/shell/${id}`, server.base)
        url.searchParams.set("location[directory]", tmp.path)
        return Effect.promise(() => fetch(url, { method, headers: server.headers }))
      }

      const missing = yield* request("DELETE", "sh_00000000000000000000000000")
      expect(missing.status).toBe(404)
      expect(yield* Effect.promise(() => missing.json())).toMatchObject({
        _tag: "ShellNotFoundError",
        id: "sh_00000000000000000000000000",
      })

      // `GET` already reported the same missing shell; removal now matches it.
      const get = yield* request("GET", "sh_00000000000000000000000000")
      expect(get.status).toBe(404)
    }),
  15_000,
)
