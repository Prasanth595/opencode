import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { $ } from "bun"
import { Effect, Schedule } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live(
  "lists a discovered icon URL and serves its bytes with cache validators",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const directory = path.join(tmp.path, "checkout")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(directory, "public"), { recursive: true })
        await fs.writeFile(path.join(directory, "public", "favicon.svg"), "<svg />")
        await $`git init -q && git remote add origin https://github.com/acme/sketchbook.git`.cwd(directory).quiet()
      })
      const server = yield* startServer(path.join(tmp.path, "config"))
      const get = (pathname: string, headers: Record<string, string> = {}) =>
        Effect.promise(() => fetch(new URL(pathname, server.base), { headers: { ...server.headers, ...headers } }))

      const location = yield* get(`/api/location?location[directory]=${encodeURIComponent(directory)}`)
      const projectID = (yield* Effect.promise(() => location.json())).project.id
      const project = yield* get("/api/project").pipe(
        Effect.flatMap((response) => Effect.promise(() => response.json())),
        Effect.map((projects: Array<{ id: string; repository?: string; icon?: { discovered?: { url: string } } }>) =>
          projects.find((item) => item.id === projectID),
        ),
        Effect.repeat({ until: (item) => !!item?.icon?.discovered, schedule: Schedule.spaced("25 millis") }),
        Effect.timeout("5 seconds"),
      )
      const url = project?.icon?.discovered?.url ?? ""
      const icon = yield* get(url)
      const etag = icon.headers.get("etag") ?? ""
      const revalidated = yield* get(url, { "if-none-match": etag })
      const unversioned = yield* get(`/api/project/${projectID}/icon`)

      expect(project?.repository).toBe("sketchbook")
      expect(url).toStartWith(`/api/project/${projectID}/icon?v=`)
      expect(icon.status).toBe(200)
      expect(icon.headers.get("content-type")).toBe("image/svg+xml")
      expect(icon.headers.get("cache-control")).toBe("private, max-age=31536000, immutable")
      expect(yield* Effect.promise(() => icon.text())).toBe("<svg />")
      expect(revalidated.status).toBe(304)
      expect(unversioned.headers.get("cache-control")).toBe("private, no-cache")
    }),
  15_000,
)
