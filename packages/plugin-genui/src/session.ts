export * as GenUISession from "./session.js"

import { Message } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import { Effect, Stream } from "effect"
import { GenUI } from "./genui.js"

const enter = `<system-reminder>
The user is viewing this session in the OpenCode app. For the occasional answer that is clearly better seen or clicked than read, such as a dashboard, a chart of real data or a form, ${GenUI.RENDER_TOOL} draws interactive UI while you write it; load the genui skill first. Answer everything else in text as usual. When the in-app browser is connected, its tools are in your tool list and the browser skill explains them.
</system-reminder>`

const leave = `<system-reminder>
${GenUI.RENDER_TOOL} is no longer available in this session, because the user is not in the OpenCode app or turned generated UI off. Answer in text.
</system-reminder>`

/**
 * Tells the agent it may use the render tool only while the user can see generated UI: the app marks its prompts with
 * `metadata.genui = true` while the setting is on, so the latest prompt decides. Sessions the app never prompted, such
 * as subagents, never see the tool.
 */
export const register = Effect.fn("GenUISession.register")(function* (ctx: {
  readonly session: Pick<Context["session"], "hook" | "synthetic">
  readonly event: Context["event"]
}) {
  // In memory only: after a restart a session counts as unknown, not left, until its next prompt.
  const available = new Map<Session.ID, boolean>()

  yield* ctx.session.hook("prompt", (event) =>
    Effect.sync(() => {
      available.set(event.sessionID, event.metadata?.genui === true)
    }),
  )

  yield* ctx.session.hook("context", (event) => {
    const offered = available.get(event.sessionID)
    const reminder = lastReminder(event.messages)
    // The tool list is the head of the cached prompt, so it must not flip with each prompt's source (app, phone,
    // scheduled prompt) or reset on restart. Once a session has been offered generated UI it keeps the tool, and the
    // reminders say whether it can be used.
    if (offered !== true && reminder === undefined) delete event.tools[GenUI.RENDER_TOOL]
    const text =
      offered === true && reminder !== enter ? enter : offered === false && reminder === enter ? leave : undefined
    if (!text) return Effect.void
    // Before the user's prompt and near the tail, like Plan mode's reminders, so the cached prefix stays warm.
    const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
    event.messages.splice(at, 0, Message.user(text))
    return ctx.session
      .synthetic({ sessionID: event.sessionID, text, resume: false })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to persist the GenUI reminder", { sessionID: event.sessionID, cause }),
        ),
      )
  })

  yield* ctx.event.subscribe().pipe(
    Stream.filter((event) => event.type === "session.deleted"),
    Stream.runForEach((event) =>
      Effect.sync(() => {
        available.delete(event.data.sessionID)
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
})

function lastReminder(messages: ReadonlyArray<Message>) {
  return messages.reduce<string | undefined>((found, message) => {
    const part = message.role === "user" && message.content.length === 1 ? message.content[0] : undefined
    if (part?.type !== "text") return found
    return part.text === enter || part.text === leave ? part.text : found
  }, undefined)
}
