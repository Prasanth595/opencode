export * as ConfigWatch from "./watch.js"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import type { Watcher } from "../filesystem/watcher.js"
import type { ConfigDiscovery } from "./discovery.js"
import { AbsolutePath } from "../schema.js"

export const plan = Effect.fn("ConfigWatch.plan")(function* (sources: ConfigDiscovery.Sources) {
  const fs = yield* FSUtil.Service
  // Resolve a symlinked root before subscribing: inotify rejects the link itself with ENOTDIR, and events
  // report real paths, so a watch on the link never observes edits made through it.
  const directories = yield* Effect.forEach(
    [
      ...(sources.global ? [sources.global] : []),
      ...sources.project.filter((root) => root.present).map((root) => root.path),
    ],
    (directory) => fs.resolve(directory).pipe(Effect.map(AbsolutePath.make)),
  )
  const files = [
    ...sources.direct,
    ...sources.project.map((root) => root.path),
    ...sources.claude,
    ...sources.agents,
    ...(sources.explicit ? [sources.explicit] : []),
  ]
  // Keep a parent watch for each root so deletion/recreation is observable.
  const parents = Map.groupBy(
    files.filter((file) => !directories.some((directory) => file !== directory && FSUtil.contains(directory, file))),
    (file) => path.dirname(file),
  )
  return new Map(
    [
      ...directories.map((path) => ({
        path,
        type: "directory" as const,
        ignore: ["node_modules", ".git", "**/{node_modules,.git}/**"],
      })),
      ...Array.from(parents, ([parent, files]) => ({
        path: parent,
        type: "entries" as const,
        names: [...new Set(files.map((file) => path.basename(file)))].toSorted(),
      })),
    ].map((target) => [JSON.stringify(target), target satisfies Watcher.WatchInput]),
  )
})
