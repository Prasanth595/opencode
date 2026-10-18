import { type ComponentProps, splitProps, Show } from "solid-js"
import "./project-avatar.css"

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined

function first(value: string) {
  if (!value) return ""

  if (!segmenter) return Array.from(value)[0] ?? ""

  return segmenter.segment(value)[Symbol.iterator]().next().value?.segment ?? Array.from(value)[0] ?? ""
}

export const PROJECT_AVATAR_VARIANTS = [
  "orange",
  "yellow",
  "cyan",
  "green",
  "red",
  "pink",
  "blue",
  "purple",
  "gray",
] as const

export type ProjectAvatarVariant = (typeof PROJECT_AVATAR_VARIANTS)[number]

// "outline" is a neutral, muted style (e.g. recently closed projects) and is not part of the color rotation.
export type ProjectAvatarStyle = ProjectAvatarVariant | "outline"

// Project IDs hash the normalized origin remote (`git-remote:github.com/anomalyco/opencode`); V1 used the root commit.
const OPENCODE_PROJECT_IDS = new Set([
  "012780c4098d08caa4ea8c479ed0a4690489f38d",
  "476fbfe6befa9e63ddd7f9ae71655999a0104256",
  "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750",
])

export type ProjectAvatarIcon = { color?: string; url?: string; override?: string; discovered?: { url: string } }

/**
 * A chosen image wins, then a chosen color tile, then the automatic icon. `resolve` maps a server-relative
 * discovered icon URL to something an image element can load.
 */
export function getProjectAvatarSource(
  id?: string,
  icon?: ProjectAvatarIcon,
  resolve: (url: string) => string | undefined = () => undefined,
) {
  if (icon?.override) return icon.override

  if (icon?.color) return undefined

  if (id && OPENCODE_PROJECT_IDS.has(id)) return "https://opencode.ai/favicon.svg"

  const discovered = icon?.discovered?.url

  if (discovered) return /^(https?:|data:)/i.test(discovered) ? discovered : (resolve(discovered) ?? icon?.url)

  return icon?.url
}

const AUTOMATIC_VARIANTS = PROJECT_AVATAR_VARIANTS.filter((variant) => variant !== "gray")

/** A chosen color, else a stable color derived from `seed` (the project ID), else gray. */
export function getProjectAvatarVariant(key?: string, seed?: string): ProjectAvatarVariant {
  if (key === "mint") return "cyan"

  if (key === "lime") return "green"

  if (
    key === "orange" ||
    key === "yellow" ||
    key === "cyan" ||
    key === "green" ||
    key === "red" ||
    key === "pink" ||
    key === "blue" ||
    key === "purple" ||
    key === "gray"
  )
    return key

  if (!seed) return "gray"

  const hash = Array.from(seed).reduce((value, char) => Math.imul(value ^ char.charCodeAt(0), 0x01000193), 0x811c9dc5)

  return AUTOMATIC_VARIANTS[(hash >>> 0) % AUTOMATIC_VARIANTS.length]
}

export const displayName = (project: { name?: string; repository?: string; worktree: string }) => {
  const trimmed = project.worktree.replace(/[/\\]+$/, "")
  const filename = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1)

  return project.name || project.repository || filename || project.worktree
}

export interface ProjectAvatarProps extends ComponentProps<"div"> {
  fallback: string
  src?: string
  variant?: ProjectAvatarStyle
  unread?: boolean
}

export function ProjectAvatar(props: ProjectAvatarProps) {
  const [split, rest] = splitProps(props, ["fallback", "src", "variant", "unread", "class", "classList", "style"])

  return (
    <div
      {...rest}
      data-component="project-avatar-v2"
      data-unread={split.unread ? "" : undefined}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      style={typeof split.style === "object" ? split.style : undefined}
    >
      <div
        data-slot="project-avatar-surface"
        data-variant={split.variant ?? "gray"}
        data-has-image={split.src ? "" : undefined}
      >
        <Show when={split.src} fallback={first(split.fallback)}>
          {(value) => <img src={value()} draggable={false} data-slot="project-avatar-image" />}
        </Show>
      </div>
      <Show when={split.unread}>
        <span data-slot="project-avatar-unread-dot" aria-hidden="true" />
      </Show>
    </div>
  )
}
