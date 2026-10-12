import type { AssistantMessage, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"

export function subagentDuration(
  state: ToolPart["state"],
  messages: readonly (Pick<UserMessage, "role" | "time"> | Pick<AssistantMessage, "role" | "time">)[],
) {
  // A resumed session includes earlier tasks and idle gaps. Use this invocation's own clock.
  // Background tasks return before the child finishes, so their tool end time is not the run end.
  if (state.status === "completed" && state.metadata.background !== true) return state.time.end - state.time.start

  const first = messages.find((x) => x.role === "user")?.time.created
  const assistant = messages.findLast((x) => x.role === "assistant")?.time.completed
  if (!first || !assistant) return 0
  return assistant - first
}
