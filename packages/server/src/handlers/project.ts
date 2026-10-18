import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { FileNotFoundError, ProjectNotFoundError } from "@opencode/protocol/errors"

export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  handlers
    .handle("project.list", (ctx) => Project.Service.use((project) => project.list(ctx.query)))
    .handle("project.icons", () =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const project = yield* Project.Service
        return yield* project.icons(location.project.directory)
      }),
    )
    .handleRaw("project.icon", (ctx) =>
      Effect.gen(function* () {
        const project = yield* Project.Service
        const image = yield* project.icon(ctx.params.projectID).pipe(
          Effect.mapError(
            () =>
              new ProjectNotFoundError({
                projectID: ctx.params.projectID,
                message: `Project not found: ${ctx.params.projectID}`,
              }),
          ),
        )
        if (!image) return yield* new FileNotFoundError({ path: "icon", message: "Project has no icon" })
        const etag = `"${image.hash}"`
        const headers = {
          etag,
          // The versioned URL names exact bytes; an unversioned or stale URL must revalidate.
          "cache-control": ctx.query.v === image.hash ? "private, max-age=31536000, immutable" : "private, no-cache",
        }
        if (ctx.request.headers["if-none-match"] === etag) return HttpServerResponse.empty({ status: 304, headers })
        return HttpServerResponse.uint8Array(image.bytes, { contentType: image.type, headers })
      }),
    )
    .handle("project.update", (ctx) =>
      Project.Service.use((project) =>
        project.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
          Effect.mapError(
            () =>
              new ProjectNotFoundError({
                projectID: ctx.params.projectID,
                message: `Project not found: ${ctx.params.projectID}`,
              }),
          ),
        ),
      ),
    ),
)
