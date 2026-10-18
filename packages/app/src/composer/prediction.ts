import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { ServerSDK } from "@/runtime/server/client"

const prompt = `Predict the user's next message from the conversation so far.
Write one short, natural follow-up from the user's perspective, in the user's language.
Suggest only an obvious next step supported by the conversation. Do not invent new work,
repeat a completed request, or propose destructive actions or external side effects.
Return only the suggested message, without quotes, markdown, explanation, or a label.
Keep it under 200 characters. If no useful follow-up is clear, return exactly NO_SUGGESTION.`

export function createComposerPrediction(input: {
  sessionID: string
  eligible: Accessor<boolean>
  sdk: Pick<ServerSDK, "api" | "event">
}) {
  const [state, setState] = createStore({ text: undefined as string | undefined })
  let request: AbortController | undefined
  let completed: string | undefined

  const dismiss = () => {
    request?.abort()
    request = undefined
    setState("text", undefined)
  }

  createEffect(() => {
    if (!input.eligible()) dismiss()
  })

  const unsubscribe = input.sdk.event.on("session.execution.succeeded", (event) => {
    if (event.data.sessionID !== input.sessionID || event.id === completed) return
    completed = event.id
    dismiss()

    if (!input.eligible()) return
    const current = new AbortController()
    request = current
    void input.sdk.api.session.generate({ sessionID: input.sessionID, prompt }, { signal: current.signal }).then(
      (result) => {
        if (current.signal.aborted || !input.eligible()) return
        request = undefined
        const text = result.text.trim()

        if (text && text !== "NO_SUGGESTION") setState("text", text)
      },
      () => {
        if (request === current) request = undefined
      },
    )
  })

  onCleanup(() => {
    unsubscribe()
    dismiss()
  })

  return { text: () => state.text, dismiss }
}

export type ComposerPrediction = ReturnType<typeof createComposerPrediction>
