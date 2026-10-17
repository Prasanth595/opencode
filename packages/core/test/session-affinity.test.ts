import { expect } from "bun:test"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionAffinity } from "@opencode/core/session/affinity"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Project } from "@opencode/schema/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionStore.node])))

const root = Session.ID.make("ses_affinity_root")
const middle = Session.ID.make("ses_affinity_middle")
const leaf = Session.ID.make("ses_affinity_leaf")
const child = Session.ID.make("ses_affinity_child")

const ensureProject = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const insert = (id: Session.ID, fork?: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: AbsolutePath.make("/project"),
        title: id,
        version: "test",
        ...(fork
          ? { fork_session_id: fork, fork_boundary: { type: "before", messageID: SessionMessage.ID.create() } }
          : {}),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const info = (id: Session.ID) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    return yield* store.get(id)
  })

it.effect("a fork of a fork groups its requests with the root, not the intermediate fork", () =>
  Effect.gen(function* () {
    yield* ensureProject
    yield* insert(root)
    yield* insert(middle, root)
    yield* insert(leaf, middle)

    const leafInfo = yield* info(leaf)
    const middleInfo = yield* info(middle)
    const rootInfo = yield* info(root)
    expect(leafInfo && middleInfo && rootInfo).toBeDefined()
    const lineage = SessionAffinity.make((yield* Database.Service).db)

    // The intermediate fork is the session the leaf was taken from.
    expect(leafInfo?.fork?.sessionID).toBe(middle)

    // Both forks share the root's cache key, because their prefixes are the root's.
    expect(yield* lineage.root(leafInfo!)).toBe(root)
    expect(yield* lineage.root(middleInfo!)).toBe(root)
    expect(yield* lineage.root(rootInfo!)).toBe(root)
  }),
)

it.effect("a child still shares its parent's key, and a plain session its own", () =>
  Effect.gen(function* () {
    yield* ensureProject
    yield* insert(root)
    yield* insert(child)
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ parent_id: root }).where(eq(SessionTable.id, child)).run().pipe(Effect.orDie)

    const lineage = SessionAffinity.make((yield* Database.Service).db)
    const childInfo = yield* info(child)
    const rootInfo = yield* info(root)

    expect(yield* lineage.root(childInfo!)).toBe(root)
    expect(yield* lineage.root(rootInfo!)).toBe(rootInfo!.id)
  }),
)

it.effect("a fork lineage that reaches a missing session stops at the last known link", () =>
  Effect.gen(function* () {
    yield* ensureProject
    yield* insert(root)
    yield* insert(middle, root)
    // `leaf` records a source that does not exist.
    yield* insert(leaf, Session.ID.make("ses_affinity_missing"))

    const lineage = SessionAffinity.make((yield* Database.Service).db)
    const leafInfo = yield* info(leaf)
    const missing = Session.ID.make("ses_affinity_missing")

    // Nothing to walk past, so the key stays the one the session already recorded.
    expect(yield* lineage.root(leafInfo!)).toBe(missing)
  }),
)
