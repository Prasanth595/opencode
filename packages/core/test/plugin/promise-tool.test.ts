import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Tool } from "@opencode/core/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

it.live("Promise tools interrupt even when their executor receives abort without settling", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const started = yield* Deferred.make<AbortSignal>()
    const aborted = yield* Deferred.make<void>()
    yield* PluginPromise.fromPromise({
      id: "cancel-tool",
      async setup(context) {
        await context.tool.transform((editor) =>
          editor.add({
            name: "wait",
            description: "Wait until cancelled",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: (_input, context) =>
              new Promise<never>(() => {
                context.signal.addEventListener("abort", () => Effect.runSync(Deferred.succeed(aborted, undefined)), {
                  once: true,
                })
                Effect.runSync(Deferred.succeed(started, context.signal))
              }),
          }),
        )
      },
    }).effect(yield* PluginHost.make(plugins))

    const snapshot = yield* tools.snapshot()
    const fiber = yield* snapshot
      .execute({
        sessionID: Session.ID.make("ses_promise_tool_cancel"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_promise_tool_cancel"),
        call: { type: "tool-call", id: "call_promise_tool_cancel", name: "wait", input: {} },
      })
      .pipe(Effect.forkScoped)
    const signal = yield* Deferred.await(started)
    expect(signal.aborted).toBe(false)
    yield* Fiber.interrupt(fiber)
    yield* Deferred.await(aborted)
    const exit = yield* Fiber.await(fiber)
    expect(signal.aborted).toBe(true)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }),
)

it.live("Promise tool can checkpoint in abort cleanup", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const started = yield* Deferred.make<void>()
    const checkpointStarted = yield* Deferred.make<void>()
    const releaseCheckpoint = yield* Deferred.make<void>()
    const checkpoints: unknown[] = []
    const errors: unknown[] = []
    yield* PluginPromise.fromPromise({
      id: "checkpoint-cleanup",
      async setup(host) {
        await host.tool.transform((editor) =>
          editor.add({
            name: "checkpoint-wait",
            description: "incremental work with abort cleanup",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: async (_input, context) => {
              await context.checkpoint("ordinary checkpoint")
              return await new Promise<never>(() => {
                context.signal.addEventListener(
                  "abort",
                  () => {
                    void context.checkpoint("partial output from abort cleanup").catch((error) => errors.push(error))
                  },
                  { once: true },
                )
                Effect.runSync(Deferred.succeed(started, undefined))
              })
            },
          }),
        )
      },
    }).effect(yield* PluginHost.make(plugins))
    const snapshot = yield* tools.snapshot()
    const fiber = yield* snapshot
      .execute({
        sessionID: Session.ID.make("ses_review_39565"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_review_39565"),
        call: { type: "tool-call", id: "call_review_39565", name: "checkpoint-wait", input: {} },
        checkpoint: (checkpoint) =>
          Effect.gen(function* () {
            if (checkpoint === "partial output from abort cleanup") {
              yield* Deferred.succeed(checkpointStarted, undefined)
              yield* Deferred.await(releaseCheckpoint)
            }
            checkpoints.push(checkpoint)
          }),
      })
      .pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
    yield* Deferred.await(checkpointStarted)
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(releaseCheckpoint, undefined)
    yield* Fiber.join(interrupt)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(errors).toEqual([])
    expect(checkpoints).toEqual(["ordinary checkpoint", "partial output from abort cleanup"])
  }),
)

it.live("Promise tool awaits asynchronous checkpoint cleanup without waiting for its executor", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const started = yield* Deferred.make<void>()
    const cleanupStarted = yield* Deferred.make<void>()
    const releaseCleanup = Promise.withResolvers<void>()
    const checkpointStarted = yield* Deferred.make<void>()
    const releaseCheckpoint = yield* Deferred.make<void>()
    const checkpoints: unknown[] = []
    const errors: unknown[] = []
    yield* PluginPromise.fromPromise({
      id: "async-checkpoint-cleanup",
      async setup(host) {
        await host.tool.transform((editor) =>
          editor.add({
            name: "async-checkpoint-wait",
            description: "Checkpoint after asynchronous abort cleanup",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: (_input, context) =>
              new Promise<never>(() => {
                context.signal.addEventListener(
                  "abort",
                  () => {
                    void context
                      .checkpoint(async () => {
                        Effect.runSync(Deferred.succeed(cleanupStarted, undefined))
                        await releaseCleanup.promise
                        return "partial output after async cleanup"
                      })
                      .catch((error) => errors.push(error))
                  },
                  { once: true },
                )
                Effect.runSync(Deferred.succeed(started, undefined))
              }),
          }),
        )
      },
    }).effect(yield* PluginHost.make(plugins))
    const snapshot = yield* tools.snapshot()
    const fiber = yield* snapshot
      .execute({
        sessionID: Session.ID.make("ses_async_checkpoint_cleanup"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_async_checkpoint_cleanup"),
        call: { type: "tool-call", id: "call_async_checkpoint_cleanup", name: "async-checkpoint-wait", input: {} },
        checkpoint: (checkpoint) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(checkpointStarted, undefined)
            yield* Deferred.await(releaseCheckpoint)
            checkpoints.push(checkpoint)
          }),
      })
      .pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
    yield* Deferred.await(cleanupStarted)
    const runningDuringCleanup = fiber.pollUnsafe()
    const checkpointedDuringCleanup = checkpoints.length
    releaseCleanup.resolve()
    yield* Deferred.await(checkpointStarted)
    const runningDuringCheckpoint = fiber.pollUnsafe()
    yield* Deferred.succeed(releaseCheckpoint, undefined)
    yield* Fiber.join(interrupt)
    expect(runningDuringCleanup).toBeUndefined()
    expect(checkpointedDuringCleanup).toBe(0)
    expect(runningDuringCheckpoint).toBeUndefined()
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    expect(errors).toEqual([])
    expect(checkpoints).toEqual(["partial output after async cleanup"])
  }),
)

it.live("Promise tool progress is cancelled with its executor", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const started = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    const progress = Promise.withResolvers<void>()
    const errors: unknown[] = []
    yield* PluginPromise.fromPromise({
      id: "cancel-progress",
      async setup(host) {
        await host.tool.transform((editor) =>
          editor.add({
            name: "progress-wait",
            description: "Report progress until cancelled",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: (_input, context) =>
              new Promise<never>(() => {
                void context
                  .progress({ stage: "running" })
                  .catch((error) => errors.push(error))
                  .finally(progress.resolve)
              }),
          }),
        )
      },
    }).effect(yield* PluginHost.make(plugins))
    const snapshot = yield* tools.snapshot()
    const fiber = yield* snapshot
      .execute({
        sessionID: Session.ID.make("ses_promise_progress_cancel"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_promise_progress_cancel"),
        call: { type: "tool-call", id: "call_promise_progress_cancel", name: "progress-wait", input: {} },
        progress: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
          ),
      })
      .pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    yield* Deferred.await(cancelled)
    yield* Effect.promise(() => progress.promise)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain("All fibers interrupted")
  }),
)

it.live("Promise metadata updates preserve an Effect tool's interruption checkpoints", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const started = yield* Deferred.make<void>()
    const cleanupStarted = yield* Deferred.make<void>()
    const releaseCleanup = yield* Deferred.make<void>()
    const checkpointed = yield* Deferred.make<void>()
    const checkpoints: unknown[] = []
    yield* tools.transform((editor) =>
      editor.add({
        name: "effect-cleanup",
        description: "Effect tool with interrupted output",
        options: { codemode: false },
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: (_input, context) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(cleanupStarted, undefined)
                yield* Deferred.await(releaseCleanup)
                yield* context.checkpoint("retained Effect cleanup output")
                yield* Deferred.succeed(checkpointed, undefined)
              }),
            ),
          ),
      }),
    )
    yield* PluginPromise.fromPromise({
      id: "update-description",
      async setup(host) {
        await host.tool.transform((editor) =>
          editor.update("effect-cleanup", (tool) => {
            tool.description = "Updated description"
          }),
        )
      },
    }).effect(yield* PluginHost.make(plugins))
    const snapshot = yield* tools.snapshot()
    const fiber = yield* snapshot
      .execute({
        sessionID: Session.ID.make("ses_effect_update_cancel"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_effect_update_cancel"),
        call: { type: "tool-call", id: "call_effect_update_cancel", name: "effect-cleanup", input: {} },
        checkpoint: (checkpoint) => Effect.sync(() => checkpoints.push(checkpoint)).pipe(Effect.asVoid),
      })
      .pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
    yield* Deferred.await(cleanupStarted)
    yield* Effect.promise(() => Bun.sleep(10))
    const settledDuringCleanup = fiber.pollUnsafe()
    yield* Deferred.succeed(releaseCleanup, undefined)
    yield* Fiber.join(interrupt)
    yield* Deferred.await(checkpointed)
    expect(settledDuringCleanup).toBeUndefined()
    expect(checkpoints).toEqual(["retained Effect cleanup output"])
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
  }),
)

const execute = (snapshot: Tool.Snapshot, name: string) =>
  snapshot
    .execute({
      sessionID: Session.ID.make("ses_promise_tool_error"),
      agent: Agent.ID.make("build"),
      messageID: SessionMessage.ID.make("msg_promise_tool_error"),
      call: { type: "tool-call", id: `call_${name}`, name, input: {} },
    })
    .pipe(Effect.exit)

it.live("Promise tool throws become tool failures", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    yield* PluginPromise.fromPromise({
      id: "throwing-tools",
      async setup(context) {
        await context.tool.transform((editor) => {
          editor.add({
            name: "plain",
            description: "Throw an Error",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: async () => {
              throw new Error("plain failure")
            },
          })
          editor.add({
            name: "typed",
            description: "Throw a Tool.Error",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: async () => {
              throw new Tool.Error({ message: "typed failure", metadata: { code: 7 } })
            },
          })
        })
      },
    }).effect(yield* PluginHost.make(plugins))

    const snapshot = yield* tools.snapshot()
    const plain = yield* execute(snapshot, "plain")
    const typed = yield* execute(snapshot, "typed")
    expect(Option.getOrUndefined(Exit.findErrorOption(plain))).toMatchObject({ message: "plain failure" })
    expect(Option.getOrUndefined(Exit.findErrorOption(typed))).toMatchObject({
      message: "typed failure",
      metadata: { code: 7 },
    })
  }),
)

it.live("Promise tools that rethrow a decline attach it to the tool failure", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const declined = new Permission.DeclinedError()
    yield* tools.transform((editor) =>
      editor.add({
        name: "guarded",
        description: "Decline every call",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: () => Effect.die(declined),
      }),
    )
    yield* PluginPromise.fromPromise({
      id: "wrapping-tool",
      async setup(context) {
        await context.tool.transform((editor) =>
          editor.update("guarded", (tool) => {
            const original = tool.execute
            tool.execute = (input, context) => original(input, context)
          }),
        )
      },
    }).effect(yield* PluginHost.make(plugins))

    const exit = yield* execute(yield* tools.snapshot(), "guarded")
    expect(Option.getOrUndefined(Exit.findErrorOption(exit))?.error).toBe(declined)
  }),
)
