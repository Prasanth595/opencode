import type { ProgramStatus, ProgramStatusKind } from "@opentui/core"
import { createEffect, onCleanup } from "solid-js"

export type PendingSession = {
  id: string
  title?: string
  state: "blocked" | "working"
  kind?: ProgramStatusKind
  message?: string
}

type ProgramStatusRenderer = {
  setProgramStatus(status: ProgramStatus): boolean
}

const APP = "opencode"
const ROOT = ""
const TITLE_BYTES = 192
const MESSAGE_BYTES = 2048
const ID_SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// Mirrors pending session state into OSC 7501 records: one root summary plus one child record per
// pending session. Terminals drop working and blocked records when the process exits.
export function createProgramStatus(input: {
  renderer: ProgramStatusRenderer
  sessions: () => PendingSession[]
}) {
  const sent = new Map<string, string>()

  const send = (key: string, status: ProgramStatus) => {
    try {
      if (!input.renderer.setProgramStatus(status)) return
    } catch (error) {
      console.debug("failed to report program status", { status, error })
      return
    }
    if (status.state === "clear") {
      sent.delete(key)
      return
    }
    sent.set(key, JSON.stringify(status))
  }

  createEffect(() => {
    const reports = programStatusReports(input.sessions())
    Array.from(sent.keys())
      .filter((key) => key !== ROOT && !reports.has(key))
      .forEach((key) => send(key, { state: "clear", id: key }))
    reports.forEach((status, key) => {
      if (sent.get(key) !== JSON.stringify(status)) send(key, status)
    })
  })

  onCleanup(() => send(ROOT, { state: "clear" }))
}

export function programStatusReports(sessions: PendingSession[]) {
  const blocked = sessions.filter((session) => session.state === "blocked")
  const working = sessions.filter((session) => session.state === "working")
  const children = sessions
    .filter((session) => ID_SEGMENT.test(session.id))
    .map((session): [string, ProgramStatus] => [session.id, record(session, session.id)])
  return new Map<string, ProgramStatus>([[ROOT, root(blocked, working)], ...children])
}

function root(blocked: PendingSession[], working: PendingSession[]): ProgramStatus {
  if (blocked.length === 1) return record(blocked[0])
  if (blocked.length > 1)
    return {
      state: "blocked",
      kind: blocked.every((session) => session.kind === blocked[0].kind) ? blocked[0].kind : undefined,
      app: APP,
      message: `${blocked.length} sessions need input`,
    }
  if (working.length === 1) return record(working[0])
  if (working.length > 1) return { state: "working", app: APP, message: `${working.length} sessions working` }
  return { state: "idle", app: APP }
}

function record(session: PendingSession, id?: string): ProgramStatus {
  const title = clip(session.title, TITLE_BYTES)
  const message = clip(session.message, MESSAGE_BYTES)
  if (session.state === "working") return { state: "working", id, app: APP, title, message }
  return { state: "blocked", kind: session.kind, id, app: APP, title, message }
}

// Records reject control characters and oversized fields, so normalize to one line within the byte limit.
function clip(input: string | undefined, bytes: number) {
  const text = (input ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return
  const encoded = encoder.encode(text)
  if (encoded.byteLength <= bytes) return text
  // Leave room for the 3-byte ellipsis and drop a code point the byte cut split.
  return decoder.decode(encoded.subarray(0, bytes - 3)).replace(/\uFFFD+$/, "") + "…"
}
