import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import path from "node:path"
import { FSUtil } from "@opencode/util/fs-util"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { GoogleVertexPlugin } from "@opencode/core/plugin/provider/google-vertex"
import { Provider } from "@opencode/core/provider"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* GoogleVertexPlugin.effect(host)
})

// Records which paths the plugin reads, including later reads through closures captured at load.
const addPluginRecordingReads = Effect.fn(function* () {
  const fs = yield* FSUtil.Service
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  const reads: string[] = []
  const record = (file: string) => Effect.sync(() => reads.push(file))
  yield* GoogleVertexPlugin.effect(host).pipe(
    Effect.provideService(
      FSUtil.Service,
      FSUtil.Service.of({
        ...fs,
        readFileStringSafe: (file) => record(file).pipe(Effect.andThen(fs.readFileStringSafe(file))),
        readDirectory: (directory, options) =>
          record(directory).pipe(Effect.andThen(fs.readDirectory(directory, options))),
        stream: (file, options) => Stream.unwrap(record(file).pipe(Effect.as(fs.stream(file, options)))),
      }),
    ),
  )
  return reads
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

describe("GoogleVertexPlugin", () => {
  it.effect("reads gcloud configuration only when the integration is requested", () =>
    withTempDir((gcloud) =>
      withEnv(
        {
          CLOUDSDK_CONFIG: gcloud.path,
          GOOGLE_VERTEX_PROJECT: undefined,
          GOOGLE_CLOUD_PROJECT: undefined,
          GCP_PROJECT: undefined,
          GCLOUD_PROJECT: undefined,
          GOOGLE_VERTEX_LOCATION: undefined,
          GOOGLE_CLOUD_LOCATION: undefined,
          VERTEX_LOCATION: undefined,
        },
        () =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Promise.all([
                Bun.write(path.join(gcloud.path, "active_config"), "work\n"),
                Bun.write(
                  path.join(gcloud.path, "configurations", "config_default"),
                  "[core]\nproject = default-project\n[compute]\nregion = us-central1\n",
                ),
                Bun.write(path.join(gcloud.path, "configurations", "config_work"), "[core]\nproject = work-project\n"),
                Bun.write(
                  path.join(gcloud.path, "application_default_credentials.json"),
                  JSON.stringify({
                    client_secret: "client-secret",
                    refresh_token: "refresh-secret",
                    quota_project_id: "quota-project",
                  }),
                ),
              ]),
            )
            const integrations = yield* Integration.Service
            const reads = yield* addPluginRecordingReads()
            const integrationID = Integration.ID.make(Provider.ID.googleVertex)
            const listed = (yield* integrations.list()).find((item) => item.id === integrationID)
            const form = (methods: readonly Integration.Method[] | undefined) =>
              methods?.find(
                (method): method is Integration.ExternalMethod =>
                  method.type === "external" && method.id === "google-adc",
              )?.form

            expect(reads).toEqual([])
            expect(form(listed?.methods)?.some((field) => "options" in field)).toBe(false)

            const requested = yield* integrations.get(integrationID)
            const options = (values: string[]) => values.map((value) => ({ value, label: value }))
            expect(form(requested?.methods)).toMatchObject([
              {
                key: "project",
                default: "work-project",
                options: options(["work-project", "default-project"]),
              },
              { key: "location", default: "global", options: options(["global", "us", "eu", "us-central1"]) },
            ])
            expect(reads).toContain(path.join(gcloud.path, "configurations", "config_work"))
            expect(reads).not.toContain(path.join(gcloud.path, "application_default_credentials.json"))
            for (const secret of ["client-secret", "refresh-secret", "quota-project"])
              expect(JSON.stringify(requested)).not.toContain(secret)
          }),
      ),
    ),
  )

  it.effect("ignores OpenAI-compatible providers that are not Google Vertex", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      yield* catalog.transform((catalog) =>
        catalog.update(Provider.ID.opencode, (provider) => {
          provider.package = "@opencode/ai/providers/openai-compatible"
          provider.settings = { ...provider.settings, baseURL: "https://opencode.ai/zen/v1" }
        }),
      )
      yield* addPlugin()

      const provider = required(yield* catalog.get(Provider.ID.opencode))
      expect(provider.settings).toEqual({ baseURL: "https://opencode.ai/zen/v1" })
    }),
  )

  it.effect("resolves project and location from env using legacy precedence", () =>
    withEnv(
      {
        GOOGLE_CLOUD_PROJECT: "google-cloud-project",
        GCP_PROJECT: "gcp-project",
        GCLOUD_PROJECT: "gcloud-project",
        GOOGLE_VERTEX_LOCATION: "google-vertex-location",
        GOOGLE_CLOUD_LOCATION: "google-cloud-location",
        VERTEX_LOCATION: "vertex-location",
      },
      () =>
        Effect.gen(function* () {
          const catalog = yield* Provider.Service
          yield* catalog.transform((catalog) =>
            catalog.update(Provider.ID.make("google-vertex"), (provider) => {
              provider.package = "@opencode/ai/providers/google-vertex/chat"
              provider.settings = {
                ...provider.settings,
                baseURL:
                  "https://${GOOGLE_VERTEX_ENDPOINT}/v1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}",
              }
            }),
          )
          yield* addPlugin()
          const provider = required(yield* catalog.get(Provider.ID.make("google-vertex")))
          expect(provider.settings?.project).toBe("google-cloud-project")
          expect(provider.settings?.location).toBe("google-vertex-location")
          expect(provider).toMatchObject({
            package: "@opencode/ai/providers/google-vertex/chat",
            settings: {
              baseURL:
                "https://google-vertex-location-aiplatform.googleapis.com/v1/projects/google-cloud-project/locations/google-vertex-location",
            },
          })
        }),
    ),
  )

  it.effect("enables the provider when a project resolves and leaves it automatic otherwise", () =>
    withEnv(
      {
        GOOGLE_VERTEX_PROJECT: undefined,
        GOOGLE_CLOUD_PROJECT: undefined,
        GCP_PROJECT: undefined,
        GCLOUD_PROJECT: undefined,
      },
      () =>
        Effect.gen(function* () {
          const catalog = yield* Provider.Service
          yield* catalog.transform((catalog) =>
            catalog.update(Provider.ID.make("google-vertex"), (provider) => {
              provider.package = "@opencode/ai/providers/google-vertex"
            }),
          )
          yield* addPlugin()

          expect(required(yield* catalog.get(Provider.ID.make("google-vertex"))).activation).toBe("auto")
        }),
    ),
  )

  it.effect("enables the provider when a project resolves from env", () =>
    withEnv(
      {
        GOOGLE_VERTEX_PROJECT: undefined,
        GOOGLE_CLOUD_PROJECT: "adc-project",
        GCP_PROJECT: undefined,
        GCLOUD_PROJECT: undefined,
      },
      () =>
        Effect.gen(function* () {
          const catalog = yield* Provider.Service
          yield* catalog.transform((catalog) =>
            catalog.update(Provider.ID.make("google-vertex"), (provider) => {
              provider.package = "@opencode/ai/providers/google-vertex"
            }),
          )
          yield* addPlugin()

          expect(required(yield* catalog.get(Provider.ID.make("google-vertex"))).activation).toBe("enabled")
        }),
    ),
  )

  it.effect("resolves the advertised GOOGLE_VERTEX_PROJECT env for provider updates and SDKs", () =>
    withEnv(
      {
        GOOGLE_VERTEX_PROJECT: "vertex-project",
        GOOGLE_CLOUD_PROJECT: undefined,
        GCP_PROJECT: undefined,
        GCLOUD_PROJECT: undefined,
        GOOGLE_VERTEX_LOCATION: "europe-west4",
        GOOGLE_CLOUD_LOCATION: undefined,
        VERTEX_LOCATION: undefined,
      },
      () =>
        Effect.gen(function* () {
          const catalog = yield* Provider.Service
          yield* catalog.transform((catalog) =>
            catalog.update(Provider.ID.make("google-vertex"), (provider) => {
              provider.package = "@opencode/ai/providers/google-vertex/chat"
              provider.settings = {
                ...provider.settings,
                baseURL:
                  "https://${GOOGLE_VERTEX_ENDPOINT}/v1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}",
              }
            }),
          )
          yield* addPlugin()
          const provider = required(yield* catalog.get(Provider.ID.make("google-vertex")))

          expect(provider.settings?.project).toBe("vertex-project")
          expect(provider).toMatchObject({
            package: "@opencode/ai/providers/google-vertex/chat",
            settings: {
              baseURL:
                "https://europe-west4-aiplatform.googleapis.com/v1/projects/vertex-project/locations/europe-west4",
            },
          })
        }),
    ),
  )

  it.effect("keeps configured project and location over env and uses global endpoint", () =>
    withEnv(
      {
        GOOGLE_CLOUD_PROJECT: "env-project",
        GCP_PROJECT: "env-gcp-project",
        GCLOUD_PROJECT: "env-gcloud-project",
        GOOGLE_VERTEX_LOCATION: "env-location",
        GOOGLE_CLOUD_LOCATION: "env-google-cloud-location",
        VERTEX_LOCATION: "env-vertex-location",
      },
      () =>
        Effect.gen(function* () {
          const catalog = yield* Provider.Service
          const models = yield* Model.Service
          yield* catalog.transform((catalog) => {
            catalog.update(Provider.ID.make("google-vertex"), (provider) => {
              provider.package = "@opencode/ai/providers/google-vertex/chat"
              provider.settings = {
                ...provider.settings,
                baseURL:
                  "https://${GOOGLE_VERTEX_ENDPOINT}/v1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}",
              }
              provider.settings = { ...provider.settings, project: "config-project", location: "global" }
            })
            catalog.models.update(Provider.ID.make("google-vertex"), Model.ID.make("gemini"), () => {})
          })
          yield* addPlugin()
          const provider = required(yield* catalog.get(Provider.ID.make("google-vertex")))
          const model = required(yield* models.get(Provider.ID.make("google-vertex"), Model.ID.make("gemini")))
          expect(provider.settings?.project).toBe("config-project")
          expect(provider.settings?.location).toBe("global")
          expect(provider).toMatchObject({
            package: "@opencode/ai/providers/google-vertex/chat",
            settings: { baseURL: "https://aiplatform.googleapis.com/v1/projects/config-project/locations/global" },
          })
          expect(model.settings).toEqual(provider.settings)
        }),
    ),
  )

  it.effect("keeps OpenAI-compatible Vertex endpoint templates regional for eu", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      yield* catalog.transform((catalog) =>
        catalog.update(Provider.ID.make("google-vertex"), (provider) => {
          provider.package = "@opencode/ai/providers/google-vertex/chat"
          provider.settings = {
            ...provider.settings,
            baseURL:
              "https://${GOOGLE_VERTEX_ENDPOINT}/v1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}",
          }
          provider.settings = { ...provider.settings, project: "config-project", location: "eu" }
        }),
      )
      yield* addPlugin()
      const provider = required(yield* catalog.get(Provider.ID.make("google-vertex")))
      expect(provider).toMatchObject({
        package: "@opencode/ai/providers/google-vertex/chat",
        settings: { baseURL: "https://eu-aiplatform.googleapis.com/v1/projects/config-project/locations/eu" },
      })
    }),
  )

  it.effect("expands endpoint templates on Vertex chat models", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      const models = yield* Model.Service
      const modelID = Model.ID.make("meta/llama-maas")
      yield* catalog.transform((catalog) => {
        catalog.update(Provider.ID.googleVertex, (provider) => {
          provider.package = "@opencode/ai/providers/google-vertex"
          provider.settings = { project: "config-project", location: "eu" }
        })
        catalog.models.update(Provider.ID.googleVertex, modelID, (model) => {
          model.package = "@opencode/ai/providers/google-vertex/chat"
          model.settings = {
            baseURL:
              "https://${GOOGLE_VERTEX_ENDPOINT}/v1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}/endpoints/openapi",
          }
        })
      })
      yield* addPlugin()
      expect(required(yield* models.get(Provider.ID.googleVertex, modelID))).toMatchObject({
        package: "@opencode/ai/providers/google-vertex/chat",
        settings: {
          project: "config-project",
          location: "eu",
          baseURL: "https://eu-aiplatform.googleapis.com/v1/projects/config-project/locations/eu/endpoints/openapi",
        },
      })
    }),
  )

  it.effect("defaults location to global when only project is configured", () =>
    withEnv(
      {
        GOOGLE_CLOUD_PROJECT: undefined,
        GCP_PROJECT: undefined,
        GCLOUD_PROJECT: undefined,
        GOOGLE_VERTEX_LOCATION: undefined,
        GOOGLE_CLOUD_LOCATION: undefined,
        VERTEX_LOCATION: undefined,
      },
      () =>
        Effect.gen(function* () {
          const catalog = yield* Provider.Service
          yield* catalog.transform((catalog) =>
            catalog.update(Provider.ID.make("google-vertex"), (provider) => {
              provider.package = "@opencode/ai/providers/google-vertex"
              provider.settings = { ...provider.settings, project: "config-project" }
            }),
          )
          yield* addPlugin()
          const provider = required(yield* catalog.get(Provider.ID.make("google-vertex")))
          expect(provider.settings?.project).toBe("config-project")
          expect(provider.settings?.location).toBe("global")
        }),
    ),
  )
})
