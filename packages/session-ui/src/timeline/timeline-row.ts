import type { SessionMessage } from "@opencode/schema/session-message"
import { Data, Equal, Match } from "effect"

export type PartRef = {
  messageID: SessionMessage.ID
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }
  | {
      key: string
      type: "file" | "read"
      refs: PartRef[]
    }

export namespace TimelineRow {
  export class TurnGap extends Data.TaggedClass("TurnGap")<{
    userMessageID: SessionMessage.ID
  }> {}

  export class UserMessage extends Data.TaggedClass("UserMessage")<{
    userMessageID: SessionMessage.ID
  }> {}

  export class Shell extends Data.TaggedClass("Shell")<{
    userMessageID: SessionMessage.ID
    messageID: SessionMessage.ID
  }> {}

  export class Notice extends Data.TaggedClass("Notice")<{
    userMessageID: SessionMessage.ID
    messageID: SessionMessage.ID
  }> {}

  export class TurnDivider extends Data.TaggedClass("TurnDivider")<{
    userMessageID: SessionMessage.ID
  }> {}

  export class AssistantPart extends Data.TaggedClass("AssistantPart")<{
    userMessageID: SessionMessage.ID
    group: PartGroup
    previousAssistantPart: boolean
    spacing?: "tool" | "content"
  }> {}

  export class Thinking extends Data.TaggedClass("Thinking")<{
    userMessageID: SessionMessage.ID
    ref: PartRef
  }> {}

  export class Error extends Data.TaggedClass("Error")<{
    userMessageID: SessionMessage.ID
    text: string
  }> {}

  export class Retry extends Data.TaggedClass("Retry")<{
    userMessageID: SessionMessage.ID
  }> {}

  /** A compaction the server has admitted but not started. */
  export class CompactionQueued extends Data.TaggedClass("CompactionQueued")<{
    userMessageID: SessionMessage.ID
    inboxID: SessionMessage.ID
  }> {}

  export type TimelineRow =
    | TurnGap
    | UserMessage
    | Shell
    | Notice
    | TurnDivider
    | AssistantPart
    | Thinking
    | Error
    | Retry
    | CompactionQueued

  export const key: (row: TimelineRow) => string = Match.typeTags<TimelineRow>()({
    TurnGap: (row) => `turn-gap:${row.userMessageID}`,
    UserMessage: (row) => `user-message:${row.userMessageID}`,
    Shell: (row) => `shell:${row.messageID}`,
    Notice: (row) => `notice:${row.messageID}`,
    TurnDivider: (row) => `turn-divider:${row.userMessageID}`,
    // Keyed by part identity alone: a page boundary can truncate the leading turn,
    // and its rows regroup under the real user message once older history loads.
    // The group key already carries the owning message and part IDs.
    AssistantPart: (row) => `assistant-part:${row.group.type}:${row.group.key}`,
    Thinking: (row) => `thinking:${row.userMessageID}`,
    Error: (row) => `error:${row.userMessageID}`,
    Retry: (row) => `retry:${row.userMessageID}`,
    CompactionQueued: (row) => `compaction-queued:${row.inboxID}`,
  })

  export function equals(a: TimelineRow, b: TimelineRow) {
    return Equal.equals(a, b)
  }
}

export type TimelineRowMap = {
  TurnGap: { userMessageID: SessionMessage.ID }
  UserMessage: { userMessageID: SessionMessage.ID }
  Shell: { userMessageID: SessionMessage.ID; messageID: SessionMessage.ID }
  Notice: { userMessageID: SessionMessage.ID; messageID: SessionMessage.ID }
  TurnDivider: { userMessageID: SessionMessage.ID }
  AssistantPart: {
    userMessageID: SessionMessage.ID
    group: PartGroup
    previousAssistantPart: boolean
    spacing?: "tool" | "content"
  }
  Thinking: { userMessageID: SessionMessage.ID; ref: PartRef }
  Retry: { userMessageID: SessionMessage.ID }
  Error: { userMessageID: SessionMessage.ID; text: string }
  CompactionQueued: { userMessageID: SessionMessage.ID; inboxID: SessionMessage.ID }
}
