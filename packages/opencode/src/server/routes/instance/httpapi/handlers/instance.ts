import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LinkPreview } from "@/link-preview"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { LLMEvent } from "@opencode-ai/llm"
import { SessionID } from "@/session/schema"
import { Skill } from "@/skill"
import { Effect, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiVcsApplyError, ApiVcsOperationError, type LinkPreviewQuery } from "../groups/instance"
import { markInstanceForDisposal } from "../lifecycle"

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service
    const linkPreview = yield* LinkPreview.Service
    const sessions = yield* Session.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getLinkPreview = Effect.fn("InstanceHttpApi.linkPreview")(function* (ctx: {
      query: Schema.Schema.Type<typeof LinkPreviewQuery>
    }) {
      return yield* linkPreview.resolve(ctx.query)
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; context?: number }
    }) {
      return yield* vcs.diff(ctx.query.mode, { context: ctx.query.context })
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const runVcsOperation = (
      effect: Effect.Effect<Schema.Schema.Type<typeof Vcs.OperationResult>, Vcs.OperationError>,
    ) =>
      effect.pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsOperationError({
              name: "VcsOperationError",
              data: { message: error.message, operation: error.operation },
            }),
        ),
      )

    const getVcsChanges = Effect.fn("InstanceHttpApi.vcsChanges")(function* () {
      return yield* vcs.changes()
    })
    const getVcsRemote = Effect.fn("InstanceHttpApi.vcsRemote")(function* () {
      return yield* vcs.remote()
    })

    const stageVcs = Effect.fn("InstanceHttpApi.vcsStage")(function* (ctx: {
      payload: Schema.Schema.Type<typeof Vcs.FileInput>
    }) {
      return yield* runVcsOperation(vcs.stage(ctx.payload))
    })
    const unstageVcs = Effect.fn("InstanceHttpApi.vcsUnstage")(function* (ctx: {
      payload: Schema.Schema.Type<typeof Vcs.FileInput>
    }) {
      return yield* runVcsOperation(vcs.unstage(ctx.payload))
    })
    const stageAllVcs = Effect.fn("InstanceHttpApi.vcsStageAll")(function* () {
      return yield* runVcsOperation(vcs.stageAll())
    })
    const unstageAllVcs = Effect.fn("InstanceHttpApi.vcsUnstageAll")(function* () {
      return yield* runVcsOperation(vcs.unstageAll())
    })
    const discardVcs = Effect.fn("InstanceHttpApi.vcsDiscard")(function* (ctx: {
      payload: Schema.Schema.Type<typeof Vcs.FileInput>
    }) {
      return yield* runVcsOperation(vcs.discard(ctx.payload))
    })
    const commitVcs = Effect.fn("InstanceHttpApi.vcsCommit")(function* (ctx: {
      payload: Schema.Schema.Type<typeof Vcs.CommitInput>
    }) {
      return yield* runVcsOperation(vcs.commit(ctx.payload))
    })
    const fetchVcs = Effect.fn("InstanceHttpApi.vcsFetch")(function* () {
      return yield* runVcsOperation(vcs.fetch())
    })
    const pushVcs = Effect.fn("InstanceHttpApi.vcsPush")(function* () {
      return yield* runVcsOperation(vcs.push())
    })
    const pullVcs = Effect.fn("InstanceHttpApi.vcsPull")(function* () {
      return yield* runVcsOperation(vcs.pull())
    })
    const stagedDiffVcs = Effect.fn("InstanceHttpApi.vcsStagedDiff")(function* () {
      return yield* vcs.stagedDiff().pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsOperationError({
              name: "VcsOperationError",
              data: { message: error.message, operation: error.operation },
            }),
        ),
      )
    })

    const generateCommitMessage = Effect.fn("InstanceHttpApi.vcsGenerateMessage")(function* (ctx: {
      payload: Schema.Schema.Type<typeof Vcs.CommitMessageInput>
    }) {
      const [diff, sessionInfo] = yield* Effect.all(
        [
          vcs.stagedDiff().pipe(
            Effect.mapError(
              (error) =>
                new ApiVcsOperationError({
                  name: "VcsOperationError",
                  data: { message: error.message, operation: error.operation },
                }),
            ),
          ),
          sessions.get(Schema.decodeUnknownSync(SessionID)(ctx.payload.sessionID)).pipe(
            Effect.mapError(
              (error) =>
                new ApiVcsOperationError({
                  name: "VcsOperationError",
                  data: { message: error.message, operation: "message" },
                }),
            ),
          ),
        ],
        { concurrency: 2 },
      )
      if (!sessionInfo.model && !ctx.payload.model)
        return yield* new ApiVcsOperationError({
          name: "VcsOperationError",
          data: { message: "The session has no selected model", operation: "message" },
        })
      const selectedModel = ctx.payload.model
        ? {
            providerID: ProviderV2.ID.make(ctx.payload.model.providerID),
            modelID: ModelV2.ID.make(ctx.payload.model.modelID),
            variant: ctx.payload.model.variant,
          }
        : sessionInfo.model
          ? {
              providerID: sessionInfo.model.providerID,
              modelID: sessionInfo.model.id,
              variant: sessionInfo.model.variant === "default" ? undefined : sessionInfo.model.variant,
            }
          : undefined
      if (!selectedModel)
        return yield* new ApiVcsOperationError({
          name: "VcsOperationError",
          data: { message: "The session has no selected model", operation: "message" },
        })
      const selectedAgent = yield* agent.get(sessionInfo.agent ?? "build")
      const model = yield* provider.getModel(selectedModel.providerID, selectedModel.modelID).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsOperationError({
              name: "VcsOperationError",
              data: { message: error.message, operation: "message" },
            }),
        ),
      )
      const history = yield* sessions.messages({ sessionID: sessionInfo.id }).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsOperationError({
              name: "VcsOperationError",
              data: { message: error.message, operation: "message" },
            }),
        ),
      )
      const user = history.toReversed().find((message) => message.info.role === "user")
      if (!user || user.info.role !== "user")
        return yield* new ApiVcsOperationError({
          name: "VcsOperationError",
          data: { message: "The session has no user message to anchor generation", operation: "message" },
        })
      const message = yield* llm
        .stream({
          agent: selectedAgent,
          user: {
            ...user.info,
            model: {
              providerID: selectedModel.providerID,
              modelID: selectedModel.modelID,
              ...(selectedModel.variant && selectedModel.variant !== "default"
                ? { variant: selectedModel.variant }
                : {}),
            },
          },
          sessionID: sessionInfo.id,
          model,
          system: [],
          small: true,
          tools: {},
          retries: 1,
          messages: [
            {
              role: "user",
              content: `${COMMIT_MESSAGE_PROMPT}\n\n${diff}`,
            },
          ],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.mkString,
          Effect.mapError(
            (error) =>
              new ApiVcsOperationError({
                name: "VcsOperationError",
                data: { message: error instanceof Error ? error.message : String(error), operation: "message" },
              }),
          ),
        )
      const cleaned = conventionalCommit(message)
      if (!cleaned)
        return yield* new ApiVcsOperationError({
          name: "VcsOperationError",
          data: { message: "The model did not return a commit message", operation: "message" },
        })
      return { message: cleaned }
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      return yield* command.list()
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("vcsChanges", getVcsChanges)
      .handle("vcsRemote", getVcsRemote)
      .handle("linkPreview", getLinkPreview)
      .handle("vcsStage", stageVcs)
      .handle("vcsUnstage", unstageVcs)
      .handle("vcsStageAll", stageAllVcs)
      .handle("vcsUnstageAll", unstageAllVcs)
      .handle("vcsDiscard", discardVcs)
      .handle("vcsCommit", commitVcs)
      .handle("vcsFetch", fetchVcs)
      .handle("vcsPush", pushVcs)
      .handle("vcsPull", pullVcs)
      .handle("vcsStagedDiff", stagedDiffVcs)
      .handle("vcsGenerateMessage", generateCommitMessage)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)

const COMMIT_TYPES = ["feat", "fix", "docs", "chore", "refactor", "test"]
const COMMIT_TYPE_ALIASES: Record<string, string> = {
  feature: "feat",
  bugfix: "fix",
  hotfix: "fix",
  doc: "docs",
  tests: "test",
  refactoring: "refactor",
  build: "chore",
  ci: "chore",
  style: "chore",
  perf: "refactor",
}
const COMMIT_MESSAGE_PROMPT = `Write a commit message for these staged changes using Conventional Commits.

Subject format: \`type: summary\` or \`type(scope): summary\`
Allowed types:
- feat: new feature
- fix: bug fix
- docs: documentation changes
- chore: maintenance tasks
- refactor: code refactoring
- test: adding or updating tests

Subject rules:
- The scope is optional; when used, make it the lowercase name of the main affected package or area.
- The summary is imperative, starts lowercase, has no trailing period, and keeps the whole subject line under 72 characters.
- Describe the overall intent of the change, not a list of files.

Optional body:
- For a small or focused change, return only the subject line.
- When the changes include several substantial aspects that the subject cannot adequately convey, add a blank line followed by up to 5 bullet points.
- Judge complexity by distinct behaviors or concerns, not the number of changed files or lines.
- Start each bullet with \`- \` and describe a meaningful change or its purpose.
- Keep bullets concise, avoid repeating the subject, and combine closely related changes.
- Include only details supported by the staged changes; do not invent motivations, outcomes, or verification results.

Return only the commit message, with no surrounding quotes, code fences, or explanation.
Do not add signatures, author attribution, AI/model credits, “Generated by” notices, or Co-authored-by trailers.`

const CONVENTIONAL = new RegExp(`^(${COMMIT_TYPES.join("|")})(\\([a-z0-9._/-]+\\))?!?: \\S`)

// Models occasionally wrap the answer in fences or prose, so pick the first conforming subject
// and preserve only its bullet body. Coerce a bare summary when no subject matches the format.
function conventionalCommit(output: string) {
  const lines = output
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("```"))
    .map((line) => line.trim().replace(/^[`"'*]+|[`"'*]+$/g, "").trim())
    .filter(Boolean)
  const index = lines.findIndex((item) => CONVENTIONAL.test(item.toLowerCase()))
  const line = lines[index < 0 ? 0 : index]
  if (!line) return
  const match = /^([a-zA-Z]+)(\([^)]*\))?(!?):\s*(.+)$/.exec(line)
  const raw = match?.[1]?.toLowerCase() ?? ""
  const type = COMMIT_TYPE_ALIASES[raw] ?? raw
  const subject = (
    match && COMMIT_TYPES.includes(type)
      ? `${type}${match[2]?.toLowerCase() ?? ""}${match[3]}: ${match[4].replace(/\.$/, "")}`
      : `chore: ${line.charAt(0).toLowerCase()}${line.slice(1).replace(/\.$/, "")}`
  ).slice(0, 200)
  const body = lines.slice((index < 0 ? 0 : index) + 1)
  const end = body.findIndex((item) => !/^- \S/.test(item))
  const bullets = body.slice(0, end < 0 ? body.length : end).slice(0, 5)
  return bullets.length ? `${subject}\n\n${bullets.join("\n")}` : subject
}
