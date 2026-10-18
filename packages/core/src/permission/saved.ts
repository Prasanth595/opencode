export * as PermissionSaved from "./saved.js"

import { and, eq, ne } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Project } from "@opencode/schema/project"
import { Database } from "../database/database.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { PermissionTable } from "./sql.js"
import { PermissionSaved } from "@opencode/schema/permission-saved"

export const ID = PermissionSaved.ID
export type ID = typeof ID.Type

export const Info = PermissionSaved.Info
export type Info = typeof Info.Type

export const ListInput = Schema.Struct({
  projectID: Project.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionSaved.ListInput" })
export type ListInput = typeof ListInput.Type

export const AddInput = Schema.Struct({
  projectID: Project.ID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
}).annotate({ identifier: "PermissionSaved.AddInput" })
export type AddInput = typeof AddInput.Type

export const UpdateInput = Schema.Struct({
  id: ID,
  action: Schema.String.pipe(Schema.optional),
  resource: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionSaved.UpdateInput" })
export type UpdateInput = typeof UpdateInput.Type

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("PermissionSaved.NotFoundError", {
  id: ID,
}) {}

export class ConflictError extends Schema.TaggedError<ConflictError>()("PermissionSaved.ConflictError", {
  id: ID,
  action: Schema.String,
  resource: Schema.String,
}) {}

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  readonly add: (input: AddInput) => Effect.Effect<void>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFoundError | ConflictError>
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionSaved") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const list = Effect.fnUntraced(function* (input?: ListInput) {
      const rows = yield* db
        .select()
        .from(PermissionTable)
        .where(input?.projectID ? eq(PermissionTable.project_id, input.projectID) : undefined)
        .all()
        .pipe(Effect.orDie)
      return rows.map(info)
    })

    const add = Effect.fn("PermissionSaved.add")(function* (input: AddInput) {
      if (!input.resources.length) return
      yield* db
        .insert(PermissionTable)
        .values(
          input.resources.map((resource) => ({
            id: ID.create(),
            project_id: input.projectID,
            action: input.action,
            resource,
          })),
        )
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    const update = Effect.fn("PermissionSaved.update")(function* (input: UpdateInput) {
      // The duplicate check and the write run in one transaction so a concurrent save can't slip between them.
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(PermissionTable)
              .where(eq(PermissionTable.id, input.id))
              .get()
              .pipe(Effect.orDie)
            if (!current) return yield* new NotFoundError({ id: input.id })
            const action = input.action ?? current.action
            const resource = input.resource ?? current.resource
            const duplicate = yield* tx
              .select({ id: PermissionTable.id })
              .from(PermissionTable)
              .where(
                and(
                  eq(PermissionTable.project_id, current.project_id),
                  eq(PermissionTable.action, action),
                  eq(PermissionTable.resource, resource),
                  ne(PermissionTable.id, input.id),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (duplicate) return yield* new ConflictError({ id: duplicate.id, action, resource })
            const updated = yield* tx
              .update(PermissionTable)
              .set({ action, resource })
              .where(eq(PermissionTable.id, input.id))
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!updated) return yield* new NotFoundError({ id: input.id })
            return info(updated)
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))
    })

    const remove = Effect.fn("PermissionSaved.remove")(function* (id: ID) {
      yield* db.delete(PermissionTable).where(eq(PermissionTable.id, id)).run().pipe(Effect.orDie)
    })

    return Service.of({ list, add, update, remove })
  }),
)

const info = (row: typeof PermissionTable.$inferSelect): Info => ({
  id: row.id,
  projectID: row.project_id,
  action: row.action,
  resource: row.resource,
  time: {
    created: DateTime.makeUnsafe(row.time_created),
    updated: DateTime.makeUnsafe(row.time_updated),
  },
})

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
