import type { OpenCodeClient } from "@opencode/client/promise"
import { getProjectAvatarSource, type ProjectAvatarIcon } from "@opencode/ui/project-avatar"
import { createStore } from "solid-js/store"
import type { Project } from "./types"
import { imageType } from "./image"

// Discovered icon URLs name a project and a content hash, so one object URL serves every server that lists it.
const [images, setImages] = createStore<Record<string, string>>({})

const requested = new Set<string>()

/** Fetches server-relative discovered icons through the authenticated client so image elements can show them. */
export function loadProjectIcons(api: Pick<OpenCodeClient, "project">, projects: readonly Project[]) {
  for (const project of projects) {
    const discovered = project.icon?.discovered

    if (!discovered?.url.startsWith("/") || requested.has(discovered.url)) continue

    const url = discovered.url
    requested.add(url)
    api.project
      .icon({ projectID: project.id, v: new URL(url, "http://localhost").searchParams.get("v") ?? undefined })
      .then((bytes) =>
        setImages(
          url,
          URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: imageType(discovered.path ?? "") })),
        ),
      )
      .catch(() => requested.delete(url))
  }
}

export function projectAvatarSource(id?: string, icon?: ProjectAvatarIcon) {
  return getProjectAvatarSource(id, icon, (url) => images[url])
}
