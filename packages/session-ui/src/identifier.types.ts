import type { SessionID } from "@opencode/schema/session-id"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { Shell } from "@opencode/schema/shell"
import type { SessionUserActions } from "./actions"
import type { SessionDocument } from "./document"
import type { NavigateToSessionFn, SessionHrefFn } from "./context/data"
import type { createTimelineProjection, Timeline } from "./timeline/projection"
import type { PartRef } from "./timeline/timeline-row"
import type { followShellOutput } from "./tools/shell-output"

type Assert<T extends true> = T
type RevertInput = Parameters<NonNullable<SessionUserActions["revert"]>>[0]
type MessageLookup = Parameters<ReturnType<typeof createTimelineProjection>["messageByID"]["get"]>[0]

// Target the public consumers so widening an input loses the domain separation checked here.
export type IdentifierBoundaries = [
  Assert<SessionMessage.ID extends SessionDocument["sessionID"] ? false : true>,
  Assert<string extends SessionDocument["sessionID"] ? false : true>,
  Assert<SessionMessage.ID extends Parameters<NavigateToSessionFn>[0] ? false : true>,
  Assert<SessionMessage.ID extends Parameters<SessionHrefFn>[0] ? false : true>,
  Assert<SessionMessage.ID extends RevertInput["sessionID"] ? false : true>,
  Assert<SessionID extends RevertInput["messageID"] ? false : true>,
  Assert<SessionID extends PartRef["messageID"] ? false : true>,
  Assert<SessionID extends MessageLookup ? false : true>,
  Assert<string extends MessageLookup ? false : true>,
  Assert<SessionID extends Parameters<typeof Timeline.constructMessageRows>[1] ? false : true>,
  Assert<SessionID extends Parameters<typeof followShellOutput>[0]["id"] ? false : true>,
  Assert<Shell.ID extends Parameters<typeof followShellOutput>[0]["id"] ? true : false>,
  Assert<string extends PartRef["partID"] ? true : false>,
]
