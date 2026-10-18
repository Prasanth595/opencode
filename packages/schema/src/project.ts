export * as Project from "./project.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { AbsolutePath, NonNegativeInt, optional, RelativePath } from "./schema.js"
import { ProjectID } from "./project-id.js"

export const ID = ProjectID
export type ID = typeof ID.Type

export const Vcs = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9._-]*$/u)).annotate({
  identifier: "Project.Vcs",
})
export const Current = Schema.Struct({
  id: ID,
  directory: AbsolutePath,
  canonical: AbsolutePath,
}).annotate({ identifier: "Project.Current" })
export interface Current extends Schema.Schema.Type<typeof Current> {}
export const DiscoveredIcon = Schema.Struct({
  url: Schema.String.annotate({
    description:
      "Image URL. Files found in the project use the authenticated server-relative icon route, versioned by content hash so a given URL never changes; an `icon` URL from project config is returned as configured.",
  }),
  path: optional(RelativePath).annotate({
    description: "Source file relative to the directory it was found in, when the icon is a project file",
  }),
}).annotate({ identifier: "Project.DiscoveredIcon" })
export interface DiscoveredIcon extends Schema.Schema.Type<typeof DiscoveredIcon> {}
const iconFields = {
  url: optional(Schema.String),
  override: optional(Schema.String),
  color: optional(Schema.String),
}
export const Icon = Schema.Struct({
  ...iconFields,
  discovered: optional(DiscoveredIcon).annotate({
    description:
      "Icon found automatically in the project. Clients show `override` first, then the `color` tile when a color is chosen, then this icon.",
  }),
}).annotate({ identifier: "Project.Icon" })
export interface Icon extends Schema.Schema.Type<typeof Icon> {}
export const IconUpdate = Schema.Struct(iconFields).annotate({ identifier: "Project.IconUpdate" })
export interface IconUpdate extends Schema.Schema.Type<typeof IconUpdate> {}
export const iconRoute = "/api/project/:projectID/icon"
export function iconUrl(id: ID, version: string) {
  return `${iconRoute.replace(":projectID", encodeURIComponent(id))}?v=${version}`
}
export const IconCandidate = Schema.Struct({
  path: RelativePath,
  url: Schema.String,
}).annotate({ identifier: "Project.IconCandidate" })
export interface IconCandidate extends Schema.Schema.Type<typeof IconCandidate> {}
export const Commands = Schema.Struct({
  start: optional(
    Schema.String.annotate({ description: "Startup script to run when creating a new workspace (worktree)" }),
  ),
}).annotate({ identifier: "Project.Commands" })
export interface Commands extends Schema.Schema.Type<typeof Commands> {}
export const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  active: NonNegativeInt,
  archived: optional(NonNegativeInt),
}).annotate({ identifier: "Project.Time" })
export interface Time extends Schema.Schema.Type<typeof Time> {}

export const Info = Schema.Struct({
  id: ID,
  canonical: AbsolutePath,
  vcs: optional(Vcs),
  name: optional(Schema.String),
  repository: optional(Schema.String).annotate({
    description:
      "Repository name from the git origin remote, such as `team-board`. Clients show `name`, then this, then the canonical directory name.",
  }),
  icon: optional(Icon),
  commands: optional(Commands),
  time: Time,
  sandboxes: Schema.Array(Schema.String),
}).annotate({ identifier: "Project" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const UpdateInput = Schema.Struct({
  projectID: ID,
  canonical: optional(AbsolutePath),
  name: optional(Schema.String),
  icon: optional(IconUpdate),
  commands: optional(Commands),
}).annotate({ identifier: "Project.UpdateInput" })
export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}

const Updated = ephemeral({ type: "project.updated", schema: Info.fields })
export const Event = { Updated, Definitions: inventory(Updated) }
