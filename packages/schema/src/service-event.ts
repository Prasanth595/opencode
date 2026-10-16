export * as ServiceEvent from "./service-event.js"

import { Schema } from "effect"
import { Event } from "./event.js"
import { SessionID } from "./session-id.js"

export const Requested = Event.ephemeral({
  type: "server.restart.requested",
  schema: {
    active: Schema.Array(SessionID),
  },
})

export const Decision = Schema.Union([
  Schema.Literal("now"),
  Schema.Literal("idle"),
  Schema.Literal("cancel"),
])
export type Decision = typeof Decision.Type

export const Resolved = Event.ephemeral({
  type: "server.restart.resolved",
  schema: {
    decision: Decision,
  },
})

export const Definitions = Event.inventory(Requested, Resolved)
