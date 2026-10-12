import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema, Scope } from "effect"
import { formatPatch, structuredPatch } from "diff"
import { InstanceState } from "@/effect/instance-state"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Git } from "@/git"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { VcsEvent } from "@opencode-ai/schema/vcs-event"

const PATCH_CONTEXT_LINES = 2_147_483_647
const MAX_PATCH_BYTES = 10_000_000
const MAX_TOTAL_PATCH_BYTES = 10_000_000
type DiffOptions = {
  readonly context?: number
}

const emptyPatch = (file: string) => formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 }))

// Plan files are the plan agent's own working notes, not application code --
// exclude them from git status/diff so they don't clutter the review panel.
// They still get written to the worktree and can be committed manually.
const isPlanFile = (file: string) => file.startsWith(".opencode/plans/")

const nums = (list: Git.Stat[]) =>
  new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

const merge = (...lists: Git.Item[][]) => {
  const out = new Map<string, Git.Item>()
  lists.flat().forEach((item) => {
    if (!out.has(item.file)) out.set(item.file, item)
  })
  return [...out.values()]
}

const emptyBatch = () => ({ patches: new Map<string, string>(), capped: false })

const parseQuotedPath = (value: string) => {
  let out = ""
  for (let idx = 1; idx < value.length; idx++) {
    const char = value[idx]
    if (char === '"') return { value: out, end: idx + 1 }
    if (char !== "\\") {
      out += char
      continue
    }

    const next = value[++idx]
    if (next === "t") out += "\t"
    else if (next === "n") out += "\n"
    else if (next === "r") out += "\r"
    else if (next === '"' || next === "\\") out += next
    else out += next ?? ""
  }
}

const parsePathToken = (value: string) => {
  if (!value.startsWith('"')) return value.split("\t")[0]
  return parseQuotedPath(value)?.value ?? value
}

const fileFromDiffPath = (value: string | undefined) => {
  if (!value || value === "/dev/null") return
  const file = parsePathToken(value)
  if (file.startsWith("a/") || file.startsWith("b/")) return file.slice(2)
  return file
}

const fileFromGitHeader = (header: string) => {
  if (header.startsWith('"')) {
    const first = parseQuotedPath(header)
    const second = first ? header.slice(first.end).trimStart() : undefined
    if (!second) return
    if (!second.startsWith('"')) return fileFromDiffPath(second)
    return fileFromDiffPath(parseQuotedPath(second)?.value)
  }

  const separator = header.indexOf(" b/")
  if (separator === -1) return
  return fileFromDiffPath(header.slice(separator + 1))
}

const fileFromPatchChunk = (chunk: string) => {
  const next = /^\+\+\+ (.+)$/m.exec(chunk)?.[1]
  const before = /^--- (.+)$/m.exec(chunk)?.[1]
  const file = fileFromDiffPath(next) ?? fileFromDiffPath(before)
  if (file) return file

  const header = /^diff --git (.+)$/m.exec(chunk)?.[1]
  return fileFromGitHeader(header ?? "")
}

const splitGitPatch = (patch: Git.Patch) => {
  const starts = [...patch.text.matchAll(/(?:^|\n)diff --git /g)].map((match) =>
    match[0].startsWith("\n") ? match.index + 1 : match.index,
  )
  const chunks = starts.map((start, index) => patch.text.slice(start, starts[index + 1] ?? patch.text.length))
  if (!patch.truncated) return chunks
  return chunks.slice(0, -1)
}

const batchPatches = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  list: Git.Item[],
  options?: DiffOptions,
) {
  if (list.length === 0) return { patches: new Map<string, string>(), capped: false }

  const result = yield* git.patchAll(cwd, ref, {
    context: options?.context ?? PATCH_CONTEXT_LINES,
    maxOutputBytes: MAX_TOTAL_PATCH_BYTES,
  })

  return {
    patches: splitGitPatch(result).reduce((acc, patch, index) => {
      const file = fileFromPatchChunk(patch) ?? list[index]?.file
      if (!file) return acc
      acc.set(file, (acc.get(file) ?? "") + patch)
      return acc
    }, new Map<string, string>()),
    capped: result.truncated,
  }
})

const nativePatch = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  options?: DiffOptions,
) {
  const result =
    item.code === "??" || !ref
      ? yield* git.patchUntracked(cwd, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
      : yield* git.patch(cwd, ref, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
  if (!result.truncated && result.text) return result.text

  return emptyPatch(item.file)
})

const totalPatch = (file: string, patch: string, total: number) => {
  if (total + Buffer.byteLength(patch) <= MAX_TOTAL_PATCH_BYTES) return { patch, capped: false }
  return { patch: emptyPatch(file), capped: true }
}

const patchForItem = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  batch: { patches: Map<string, string>; capped: boolean },
  capped: boolean,
  options?: DiffOptions,
) {
  if (capped) return emptyPatch(item.file)

  const batched = batch.patches.get(item.file)
  if (batched !== undefined) return batched
  if (item.code !== "??" && batch.capped) return emptyPatch(item.file)
  return yield* nativePatch(git, cwd, ref, item, options)
})

const files = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  list: Git.Item[],
  map: Map<string, { additions: number; deletions: number }>,
  batch: { patches: Map<string, string>; capped: boolean },
  options?: DiffOptions,
) {
  const next: FileDiff[] = []
  let total = 0
  let capped = false

  for (const item of list.toSorted((a, b) => a.file.localeCompare(b.file))) {
    if (isPlanFile(item.file)) continue
    const stat = map.get(item.file) ?? (item.status === "added" ? yield* git.statUntracked(cwd, item.file) : undefined)
    const patch = yield* patchForItem(git, cwd, ref, item, batch, capped, options)
    const result: { patch: string; capped: boolean } = capped
      ? { patch, capped: true }
      : totalPatch(item.file, patch, total)
    capped = capped || result.capped
    if (!capped) {
      total += Buffer.byteLength(result.patch)
      capped = total >= MAX_TOTAL_PATCH_BYTES
    }
    next.push({
      file: item.file,
      patch: result.patch,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      status: item.status,
    })
  }

  return next
})

const diffAgainstRef = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  options?: DiffOptions,
) {
  const [list, stats, extra] = yield* Effect.all([git.diff(cwd, ref), git.stats(cwd, ref), git.status(cwd)], {
    concurrency: 3,
  })
  return yield* files(
    git,
    cwd,
    ref,
    merge(
      list,
      extra.filter((item) => item.code === "??"),
    ),
    nums(stats),
    yield* batchPatches(git, cwd, ref, list, options),
    options,
  )
})

const track = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  options?: DiffOptions,
) {
  if (!ref) return yield* files(git, cwd, ref, yield* git.status(cwd), new Map(), emptyBatch(), options)
  return yield* diffAgainstRef(git, cwd, ref, options)
})

export const Mode = Schema.Literals(["git", "branch"])
export type Mode = Schema.Schema.Type<typeof Mode>

export const Event = VcsEvent

export const Info = Schema.Struct({
  branch: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const FileDiff = Schema.Struct({
  file: Schema.String,
  // Mirrors Snapshot.FileDiff (see #26574). The current producer always
  // populates patch, but loosening matches the sibling schema so a
  // future code path that omits it can't crash /instance/vcs/diff.
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "VcsFileDiff" })
export type FileDiff = Schema.Schema.Type<typeof FileDiff>

export const FileStatus = Schema.Struct({
  file: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "VcsFileStatus" })
export type FileStatus = Schema.Schema.Type<typeof FileStatus>

export const ChangeStatus = Schema.Struct({
  file: Schema.String,
  staged: Schema.Boolean,
  unstaged: Schema.Boolean,
  untracked: Schema.Boolean,
}).annotate({ identifier: "VcsChangeStatus" })
export type ChangeStatus = Schema.Schema.Type<typeof ChangeStatus>

export const RemoteStatus = Schema.Struct({
  upstream: Schema.Boolean,
  ahead: Schema.Finite,
  behind: Schema.Finite,
}).annotate({ identifier: "VcsRemoteStatus" })
export type RemoteStatus = Schema.Schema.Type<typeof RemoteStatus>

export const FileInput = Schema.Struct({ file: Schema.String })
export type FileInput = Schema.Schema.Type<typeof FileInput>
export const CommitInput = Schema.Struct({ message: Schema.String })
export type CommitInput = Schema.Schema.Type<typeof CommitInput>
export const CommitMessageInput = Schema.Struct({
  sessionID: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      variant: Schema.optional(Schema.String),
    }),
  ),
})
export const CommitMessage = Schema.Struct({ message: Schema.String })
export const OperationResult = Schema.Struct({ success: Schema.Boolean, output: Schema.String })
export type OperationResult = Schema.Schema.Type<typeof OperationResult>

export class OperationError extends Schema.TaggedErrorClass<OperationError>()("VcsOperationError", {
  message: Schema.String,
  operation: Schema.Literals(["stage", "unstage", "discard", "commit", "fetch", "push", "pull", "message"]),
}) {}

const safeFile = (file: string) =>
  file.length > 0 &&
  file !== "." &&
  !file.includes("\0") &&
  !file.startsWith("/") &&
  !file.startsWith("\\") &&
  !file.split(/[\\/]/).includes("..")

const STAGED_PATCH_BUDGET = 60_000
const STAGED_PATCH_MIN_SHARE = 400

// Keeps commit-message prompts bounded for any commit size: the stat always lists every staged
// file, and the patch budget is shared fairly so small files stay whole while huge ones
// (lockfiles, generated code) are cut down instead of crowding everything else out.
function summarizeStagedDiff(stat: string, patch: Git.Patch) {
  const chunks = splitGitPatch(patch)
  const bySize = chunks.map((chunk, index) => ({ chunk, index })).toSorted((a, b) => a.chunk.length - b.chunk.length)
  const kept = bySize.reduce(
    (acc, item, position) => {
      const share = Math.floor(acc.left / (bySize.length - position))
      if (share < STAGED_PATCH_MIN_SHARE) return acc
      const text = item.chunk.length <= share ? item.chunk : `${item.chunk.slice(0, share)}\n[... diff truncated]\n`
      acc.parts[item.index] = text
      acc.left -= text.length
      return acc
    },
    { left: STAGED_PATCH_BUDGET, parts: [] as string[] },
  ).parts
  const omitted = chunks.length - kept.filter(Boolean).length
  return [
    "Staged files:",
    stat.trim(),
    "",
    "Staged patch (large files truncated):",
    kept.filter(Boolean).join(""),
    omitted > 0 || patch.truncated ? "[Some file diffs were omitted; rely on the staged file list above.]" : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export const ApplyInput = Schema.Struct({
  patch: Schema.String,
})
export type ApplyInput = Schema.Schema.Type<typeof ApplyInput>

export const ApplyResult = Schema.Struct({
  applied: Schema.Boolean,
})
export type ApplyResult = Schema.Schema.Type<typeof ApplyResult>

export class PatchApplyError extends Schema.TaggedErrorClass<PatchApplyError>()("VcsPatchApplyError", {
  message: Schema.String,
  reason: Schema.Literals(["non-git", "not-clean"]),
}) {}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly branch: () => Effect.Effect<string | undefined>
  readonly defaultBranch: () => Effect.Effect<string | undefined>
  readonly status: () => Effect.Effect<FileStatus[]>
  readonly diff: (mode: Mode, options?: DiffOptions) => Effect.Effect<FileDiff[]>
  readonly diffRaw: () => Effect.Effect<string>
  readonly apply: (input: ApplyInput) => Effect.Effect<ApplyResult, PatchApplyError>
  readonly changes: () => Effect.Effect<ChangeStatus[]>
  readonly remote: () => Effect.Effect<RemoteStatus>
  readonly stage: (input: FileInput) => Effect.Effect<OperationResult, OperationError>
  readonly unstage: (input: FileInput) => Effect.Effect<OperationResult, OperationError>
  readonly stageAll: () => Effect.Effect<OperationResult, OperationError>
  readonly unstageAll: () => Effect.Effect<OperationResult, OperationError>
  readonly discard: (input: FileInput) => Effect.Effect<OperationResult, OperationError>
  readonly commit: (input: CommitInput) => Effect.Effect<OperationResult, OperationError>
  readonly fetch: () => Effect.Effect<OperationResult, OperationError>
  readonly push: () => Effect.Effect<OperationResult, OperationError>
  readonly pull: () => Effect.Effect<OperationResult, OperationError>
  readonly stagedDiff: () => Effect.Effect<string, OperationError>
}

interface State {
  current: string | undefined
  root: Git.Base | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Vcs") {}

const layer: Layer.Layer<Service, never, Git.Service | EventV2Bridge.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope
    const checkResult = Effect.fnUntraced(function* (operation: OperationError["operation"], result: Git.Result) {
      if (result.exitCode !== 0)
        return yield* new OperationError({
          message: result.stderr.toString("utf8").trim() || result.text().trim() || `Git ${operation} failed`,
          operation,
        })
      return { success: true, output: result.text().trim() }
    })
    const runFileOperation = Effect.fnUntraced(function* (operation: "stage" | "unstage", file: string) {
      const ctx = yield* InstanceState.context
      if (!safeFile(file)) return yield* new OperationError({ message: "Invalid file path", operation })
      if (ctx.project.vcs !== "git") return yield* new OperationError({ message: "Not a Git repository", operation })
      const item = (yield* git.status(ctx.directory)).find((entry) => entry.file === file)
      if (!item || (operation === "stage" ? item.code[1] === " " : item.code[0] === " " || item.code[0] === "?"))
        return yield* new OperationError({ message: "File has no changes for this action", operation })
      const result =
        operation === "stage" ? yield* git.stage(ctx.directory, file) : yield* git.unstage(ctx.directory, file)
      return yield* checkResult(operation, result)
    })
    const runAllOperation = Effect.fnUntraced(function* (operation: "stage" | "unstage") {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") return yield* new OperationError({ message: "Not a Git repository", operation })
      const files = (yield* git.status(ctx.directory))
        .filter(
          (item) =>
            !isPlanFile(item.file) &&
            (operation === "stage" ? item.code[1] !== " " : item.code[0] !== " " && item.code[0] !== "?"),
        )
        .map((item) => item.file)
      if (files.length === 0) return { success: true, output: "" }
      const result =
        operation === "stage" ? yield* git.stageAll(ctx.directory, files) : yield* git.unstageAll(ctx.directory, files)
      return yield* checkResult(operation, result)
    })

    const state = yield* InstanceState.make<State>(
      Effect.fn("Vcs.state")(function* (ctx) {
        if (ctx.project.vcs !== "git") {
          return { current: undefined, root: undefined }
        }

        const get = Effect.fnUntraced(function* () {
          return yield* git.branch(ctx.directory)
        })
        const [current, root] = yield* Effect.all([git.branch(ctx.directory), git.defaultBranch(ctx.directory)], {
          concurrency: 2,
        })
        const value = { current, root }

        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== Watcher.Event.Updated.type || event.location?.directory !== ctx.directory)
            return Effect.void
          const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
          if (!data.file.endsWith("HEAD")) return Effect.void
          return Effect.gen(function* () {
            const next = yield* get()
            if (next !== value.current) {
              value.current = next
              yield* events.publish(Event.BranchUpdated, { branch: next })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        return value
      }),
    )

    return Service.of({
      init: Effect.fn("Vcs.init")(function* () {
        yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
      }),
      branch: Effect.fn("Vcs.branch")(function* () {
        return yield* InstanceState.use(state, (x) => x.current)
      }),
      defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
        return yield* InstanceState.use(state, (x) => x.root?.name)
      }),
      status: Effect.fn("Vcs.status")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        const ref = (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined
        const [list, stats] = yield* Effect.all(
          [git.status(ctx.directory), ref ? git.stats(ctx.directory, ref) : Effect.succeed([])],
          { concurrency: 2 },
        )
        const map = nums(stats)
        return yield* Effect.forEach(
          list.toSorted((a, b) => a.file.localeCompare(b.file)).filter((item) => !isPlanFile(item.file)),
          (item) =>
            Effect.gen(function* () {
              const stat =
                map.get(item.file) ??
                (item.status === "added" ? yield* git.statUntracked(ctx.worktree, item.file) : undefined)
              return {
                file: item.file,
                additions: stat?.additions ?? 0,
                deletions: stat?.deletions ?? 0,
                status: item.status,
              } satisfies FileStatus
            }),
        )
      }),
      changes: Effect.fn("Vcs.changes")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        return (yield* git.status(ctx.directory))
          .filter((item) => !isPlanFile(item.file))
          .map((item) => ({
            file: item.file,
            staged: item.code[0] !== " " && item.code[0] !== "?",
            unstaged: item.code[1] !== " ",
            untracked: item.code === "??",
          }))
      }),
      remote: Effect.fn("Vcs.remote")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return { upstream: false, ahead: 0, behind: 0 }
        const counts = yield* git.aheadBehind(ctx.directory)
        return { upstream: counts !== undefined, ahead: counts?.ahead ?? 0, behind: counts?.behind ?? 0 }
      }),
      stage: Effect.fn("Vcs.stage")(function* (input: FileInput) {
        return yield* runFileOperation("stage", input.file)
      }),
      unstage: Effect.fn("Vcs.unstage")(function* (input: FileInput) {
        return yield* runFileOperation("unstage", input.file)
      }),
      stageAll: Effect.fn("Vcs.stageAll")(function* () {
        return yield* runAllOperation("stage")
      }),
      unstageAll: Effect.fn("Vcs.unstageAll")(function* () {
        return yield* runAllOperation("unstage")
      }),
      discard: Effect.fn("Vcs.discard")(function* (input: FileInput) {
        const ctx = yield* InstanceState.context
        if (!safeFile(input.file))
          return yield* new OperationError({ message: "Invalid file path", operation: "discard" })
        if (ctx.project.vcs !== "git")
          return yield* new OperationError({ message: "Not a Git repository", operation: "discard" })
        const item = (yield* git.status(ctx.directory)).find((entry) => entry.file === input.file)
        if (!item || item.code[1] === " ")
          return yield* new OperationError({ message: "File has no unstaged changes", operation: "discard" })
        return yield* checkResult("discard", yield* git.discard(ctx.directory, input.file, item.code === "??"))
      }),
      commit: Effect.fn("Vcs.commit")(function* (input: CommitInput) {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git")
          return yield* new OperationError({ message: "Not a Git repository", operation: "commit" })
        if (!input.message.trim())
          return yield* new OperationError({ message: "Commit message cannot be empty", operation: "commit" })
        if (!(yield* git.status(ctx.directory)).some((item) => item.code[0] !== " " && item.code[0] !== "?"))
          return yield* new OperationError({ message: "No staged changes to commit", operation: "commit" })
        return yield* checkResult("commit", yield* git.commit(ctx.directory, input.message))
      }),
      fetch: Effect.fn("Vcs.fetch")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git")
          return yield* new OperationError({ message: "Not a Git repository", operation: "fetch" })
        return yield* checkResult("fetch", yield* git.fetch(ctx.directory))
      }),
      push: Effect.fn("Vcs.push")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git")
          return yield* new OperationError({ message: "Not a Git repository", operation: "push" })
        return yield* checkResult("push", yield* git.push(ctx.directory))
      }),
      pull: Effect.fn("Vcs.pull")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git")
          return yield* new OperationError({ message: "Not a Git repository", operation: "pull" })
        return yield* checkResult("pull", yield* git.pull(ctx.directory))
      }),
      stagedDiff: Effect.fn("Vcs.stagedDiff")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git")
          return yield* new OperationError({ message: "Not a Git repository", operation: "message" })
        const [stat, patch] = yield* Effect.all([git.stagedStat(ctx.directory), git.stagedDiff(ctx.directory)], {
          concurrency: 2,
        })
        const failed = [stat, patch].find((result) => result.exitCode !== 0)
        if (failed)
          return yield* new OperationError({
            message: failed.stderr.toString("utf8").trim() || "Could not read staged changes",
            operation: "message",
          })
        if (!stat.text().trim())
          return yield* new OperationError({ message: "No staged changes to summarize", operation: "message" })
        return summarizeStagedDiff(stat.text(), { text: patch.text(), truncated: patch.truncated })
      }),
      diff: Effect.fn("Vcs.diff")(function* (mode: Mode, options?: DiffOptions) {
        const value = yield* InstanceState.get(state)
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        if (mode === "git") {
          return yield* track(git, ctx.directory, (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined, options)
        }

        if (!value.root) return []
        if (value.current && value.current === value.root.name) return []
        const ref = yield* git.mergeBase(ctx.directory, value.root.ref)
        if (!ref) return []
        return yield* diffAgainstRef(git, ctx.directory, ref, options)
      }),
      diffRaw: Effect.fn("Vcs.diffRaw")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return ""
        const [hasHead, status] = yield* Effect.all([git.hasHead(ctx.directory), git.status(ctx.directory)], {
          concurrency: 2,
        })
        const tracked = hasHead ? (yield* git.patchAll(ctx.directory, "HEAD")).text : ""
        const untracked = yield* Effect.forEach(
          status.filter((item) => item.code === "??"),
          (item) => git.patchUntracked(ctx.directory, item.file).pipe(Effect.map((patch) => patch.text)),
        )
        return [tracked, ...untracked].filter(Boolean).join("\n")
      }),
      apply: Effect.fn("Vcs.apply")(function* (input: ApplyInput) {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") {
          return yield* new PatchApplyError({
            message: "Patch can't be applied because the project is not git-based",
            reason: "non-git",
          })
        }
        const applied = yield* git.applyPatch(ctx.directory, input.patch)
        if (applied.exitCode !== 0) {
          return yield* new PatchApplyError({
            message: "Patch can't be applied",
            reason: "not-clean",
          })
        }
        return { applied: true }
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Git.node, EventV2Bridge.node] })

export * as Vcs from "./vcs"
