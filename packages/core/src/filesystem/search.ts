export * as FileSystemSearch from "./search.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import path from "path"
import { Clock, Context, Deferred, Duration, Effect, Layer, Schema, Scope } from "effect"
import { Fff } from "#fff"
import fuzzysort from "fuzzysort"
import { FileSystem } from "@opencode/schema/filesystem"
import { Location } from "../location.js"
import { Ripgrep } from "../ripgrep.js"
import { RelativePath } from "../schema.js"
import { Protected } from "./protected.js"

export interface Interface {
  readonly find: (input: FileSystem.FindInput) => Effect.Effect<FileSystem.Entry[]>
}

export const Options = Schema.Struct({
  fff: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@opencode/FileSystem/Search") {}

// A query after this much quiet opens a new search session, such as a user opening the @ picker.
const SESSION_GAP = Duration.toMillis("2 seconds")
// Queries wait at most this long after a session opens for the index revalidation it started.
const FRESH_WAIT = Duration.toMillis("250 millis")
// Long sessions still revalidate, in the background.
const MAX_AGE = Duration.toMillis("10 seconds")
type Prepared = ReturnType<typeof fuzzysort.prepare>

/**
 * Indexes revalidate once per search session instead of trusting file watchers, which report ready
 * on WSL /mnt drives and network mounts yet never deliver their changes. Queries briefly wait on the
 * revalidation, so typical repositories answer with files created since the previous session.
 */
function revalidation(clock: Clock.Clock) {
  let queried = Number.NEGATIVE_INFINITY
  let refreshed = Number.NEGATIVE_INFINITY
  let deadline = Number.NEGATIVE_INFINITY
  return () => {
    const now = clock.currentTimeMillisUnsafe()
    const opens = now - queried >= SESSION_GAP
    queried = now
    if (opens) deadline = now + FRESH_WAIT
    const refresh = opens || now - refreshed >= MAX_AGE
    if (refresh) refreshed = now
    return { refresh, wait: Math.max(0, deadline - now) }
  }
}

function emptyIndex() {
  return { files: new Map<string, Prepared>(), directories: new Map<string, Prepared>() }
}

function search(index: ReturnType<typeof emptyIndex>, input: FileSystem.FindInput) {
  const items =
    input.type === "file"
      ? Array.from(index.files.values())
      : input.type === "directory"
        ? Array.from(index.directories.values())
        : [...index.files.values(), ...index.directories.values()]
  const result = fuzzysort.go(input.query, items, { limit: input.limit ?? 50 })
  // Targets are owned by the current location index. The only global fuzzysort
  // state left is its query cache, which must not retain every query forever.
  fuzzysort.cleanup()
  return result.map((item) => {
    const relative = item.target
    const type = relative.endsWith(path.sep) ? ("directory" as const) : ("file" as const)
    return FileSystem.Entry.make({
      path: RelativePath.make(relative),
      type,
    })
  })
}

export const ripgrepLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const ripgrep = yield* Ripgrep.Service
    const scope = yield* Scope.Scope
    const plan = revalidation(yield* Clock.Clock)
    const home = Protected.isHome(location.directory)
    let index = emptyIndex()
    let initialized = false
    let refreshing: Deferred.Deferred<void> | undefined
    const scan = Effect.gen(function* () {
      const next = emptyIndex()
      const previous = index
      if (!initialized) index = next
      yield* ripgrep.find({
        cwd: location.directory,
        pattern: "*",
        limit: location.vcs && !home ? Number.MAX_SAFE_INTEGER : 100_000,
        exclude: home ? [...Protected.names()].map((name) => `${name}/**`) : undefined,
        onEntry: (entry) =>
          Effect.sync(() => {
            next.files.set(entry.path, previous.files.get(entry.path) ?? fuzzysort.prepare(entry.path))
            const parts = entry.path.split("/")
            parts.slice(0, -1).forEach((_, offset) => {
              const directory = parts.slice(0, offset + 1).join("/") + path.sep
              if (!next.directories.has(directory))
                next.directories.set(directory, previous.directories.get(directory) ?? fuzzysort.prepare(directory))
            })
          }),
      })
      index = next
      initialized = true
    }).pipe(Effect.orDie)
    const refresh = Effect.suspend(() => {
      if (refreshing) return Effect.succeed(refreshing)
      const attempt = Deferred.makeUnsafe<void>()
      refreshing = attempt
      return scan.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (refreshing === attempt) refreshing = undefined
            Deferred.doneUnsafe(attempt, exit)
          }),
        ),
        Effect.forkIn(scope),
        Effect.as(attempt),
      )
    })
    return Service.of({
      find: (input) =>
        Effect.gen(function* () {
          const next = plan()
          if (!initialized) {
            yield* Deferred.await(yield* refresh)
            return search(index, input)
          }
          const pending = next.refresh ? yield* refresh : refreshing
          // A failed or slow revalidation keeps serving the previous index.
          if (pending && next.wait > 0)
            yield* Deferred.await(pending).pipe(Effect.timeoutOption(next.wait), Effect.ignoreCause)
          return search(index, input)
        }),
    })
  }),
)

export const fffLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const result = yield* Effect.try({
      try: () =>
        Fff.create({
          basePath: location.directory,
          aiMode: true,
          disableMmapCache: true,
          disableContentIndexing: true,
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((error) => Effect.logWarning("failed to initialize fff", { error }).pipe(Effect.as(undefined))),
    )
    if (!result?.ok) {
      if (result) yield* Effect.logWarning("failed to initialize fff", { error: result.error })
      return Service.of({
        find: () => Effect.succeed([]),
      })
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => result.value.destroy()))
    const clock = yield* Clock.Clock
    const plan = revalidation(clock)
    return Service.of({
      find: (input) =>
        Effect.gen(function* () {
          const next = plan()
          if (next.refresh && !result.value.isScanning()) {
            const scanned = result.value.scanFiles()
            if (!scanned.ok) yield* Effect.logWarning("failed to rescan fff index", { error: scanned.error })
          }
          // Rescans swap in atomically, but the initial scan exposes a partial index until it completes.
          const until = clock.currentTimeMillisUnsafe() + next.wait
          while (result.value.isScanning() && clock.currentTimeMillisUnsafe() < until) yield* Effect.sleep("10 millis")
          const options = { pageIndex: 0, pageSize: input.limit ?? 50 }
          const items = (() => {
            if (input.type === "file") {
              const found = result.value.fileSearch(input.query.trim(), options)
              if (!found.ok) throw found.error
              return found.value.items.map((item, index) => ({
                path: item.relativePath,
                type: "file" as const,
                score: found.value.scores[index]?.total ?? 0,
              }))
            }
            if (input.type === "directory") {
              const found = result.value.directorySearch(input.query.trim(), options)
              if (!found.ok) throw found.error
              return found.value.items.map((item, index) => ({
                path: item.relativePath,
                type: "directory" as const,
                score: found.value.scores[index]?.total ?? 0,
              }))
            }
            const found = result.value.mixedSearch(input.query.trim(), options)
            if (!found.ok) throw found.error
            return found.value.items.map((item, index) => ({
              path: item.item.relativePath,
              type: item.type,
              score: found.value.scores[index]?.total ?? 0,
            }))
          })()
          return items
            .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
            .map((item) => {
              const relative = item.path.replaceAll("\\", "/").replace(/\/$/, "")
              return FileSystem.Entry.make({
                path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                type: item.type,
              })
            })
        }),
    })
  }),
)

export const layer = (options?: Options) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const location = yield* Location.Service
      // Workspace-backed Locations resolve in a remote sandbox; fff would index the local server directory
      // in-process and serve wrong results. Ripgrep routes through the Location environment spawner.
      if (location.workspaceID) return ripgrepLayer
      if (options?.fff === false || (options?.fff === undefined && process.platform === "win32") || !Fff.available())
        return ripgrepLayer
      // Non-VCS locations can contain many repositories, so avoid eagerly content-indexing the entire aggregate tree.
      return location.vcs && !Protected.isHome(location.directory) ? fffLayer : ripgrepLayer
    }),
  )

export function configured(options?: Options) {
  return makeLocationNode({ service: Service, layer: layer(options), deps: [Location.node, Ripgrep.node] })
}

export const node = configured()
