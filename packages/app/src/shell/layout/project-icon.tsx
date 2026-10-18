import {
  displayName,
  getProjectAvatarVariant,
  ProjectAvatar,
  type ProjectAvatarProps,
} from "@opencode/ui/project-avatar"
import { splitProps } from "solid-js"
import type { LocalProject } from "@/shell/state/layout"
import { projectAvatarSource } from "@/runtime/server/project-icons"

type ProjectIconProps = Omit<ProjectAvatarProps, "fallback" | "src" | "variant"> & {
  project: Pick<LocalProject, "id" | "name" | "worktree" | "icon">
  fallback?: string
  icon?: LocalProject["icon"]
}

export function ProjectIcon(props: ProjectIconProps) {
  const [local, rest] = splitProps(props, ["project", "fallback", "icon"])
  const icon = () => local.icon ?? local.project.icon

  return (
    <ProjectAvatar
      {...rest}
      fallback={local.fallback ?? displayName(local.project)}
      src={projectAvatarSource(local.project.id, icon())}
      variant={getProjectAvatarVariant(icon()?.color, local.project.id)}
    />
  )
}
