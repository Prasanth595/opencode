import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import path from "node:path"
import { FSUtil } from "@opencode/util/fs-util"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { AmazonBedrockPlugin } from "@opencode/core/plugin/provider/amazon-bedrock"
import { Provider } from "@opencode/core/provider"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* AmazonBedrockPlugin.effect(host)
})

// Records which files the plugin reads, including later reads through closures captured at load.
// Whole-file reads are recorded separately from streamed reads, which keep only section headers.
const addPluginRecordingReads = Effect.fn(function* () {
  const fs = yield* FSUtil.Service
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  const reads = { streamed: [] as string[], whole: [] as string[] }
  yield* AmazonBedrockPlugin.effect(host).pipe(
    Effect.provideService(
      FSUtil.Service,
      FSUtil.Service.of({
        ...fs,
        readFileStringSafe: (file) =>
          Effect.sync(() => reads.whole.push(file)).pipe(Effect.andThen(fs.readFileStringSafe(file))),
        stream: (file, options) =>
          Stream.unwrap(Effect.sync(() => reads.streamed.push(file)).pipe(Effect.as(fs.stream(file, options)))),
      }),
    ),
  )
  return reads
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    fx,
    (previous) =>
      Effect.sync(() => {
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        })
      }),
  )
}

const noAmbientAWS = {
  AWS_PROFILE: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
  AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AWS_REGION: undefined,
  AWS_DEFAULT_REGION: undefined,
}

const seedBedrock = Effect.fn(function* (settings?: Provider.Settings) {
  const catalog = yield* Provider.Service
  yield* catalog.transform((catalog) => {
    catalog.update(Provider.ID.amazonBedrock, (item) => {
      item.package = "@opencode/ai/providers/amazon-bedrock"
      if (settings) item.settings = settings
    })
  })
  return catalog
})

describe("AmazonBedrockPlugin", () => {
  it.effect("moves endpoint setting to baseURL", () =>
    withEnv(noAmbientAWS, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock({ endpoint: "https://bedrock.example" })
        yield* addPlugin()
        const result = required(yield* catalog.get(Provider.ID.amazonBedrock))
        expect(result.package).toBe("@opencode/ai/providers/amazon-bedrock")
        expect(result.settings).toEqual({ baseURL: "https://bedrock.example", region: "us-east-1" })
      }),
    ),
  )

  it.effect("keeps an explicit baseURL over endpoint", () =>
    withEnv(noAmbientAWS, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock({ baseURL: "https://base.example", endpoint: "https://endpoint.example" })
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).settings).toEqual({
          baseURL: "https://base.example",
          region: "us-east-1",
        })
      }),
    ),
  )

  it.effect("only treats the bearer token env var as a key credential", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const integrationID = Integration.ID.make(Provider.ID.amazonBedrock)
      yield* integrations.transform((editor) => {
        editor.method.update({ integrationID, method: { type: "key" } })
        editor.method.update({
          integrationID,
          method: {
            type: "env",
            names: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK"],
          },
        })
      })
      yield* addPlugin()
      expect((yield* integrations.get(integrationID))?.methods.filter((method) => method.type === "env")).toEqual([
        { type: "env", names: ["AWS_BEARER_TOKEN_BEDROCK"] },
      ])
    }),
  )

  it.effect("reads AWS profile names only when the integration is requested", () =>
    withTempDir((tmp) => {
      const config = path.join(tmp.path, "config")
      const credentials = path.join(tmp.path, "credentials")
      return withEnv({ ...noAmbientAWS, AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials }, () =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                config,
                "[default]\nregion = us-east-1\n[profile work]\nregion = us-west-2\ncredential_process = config-secret\n[sso-session corp]\n",
              ),
              Bun.write(
                credentials,
                "[static]\r\naws_access_key_id = AKIAEXAMPLE\r\naws_secret_access_key = [credentials-secret]\r\n",
              ),
            ]),
          )
          const integrations = yield* Integration.Service
          const reads = yield* addPluginRecordingReads()
          const integrationID = Integration.ID.make(Provider.ID.amazonBedrock)
          const listed = (yield* integrations.list()).find((item) => item.id === integrationID)
          const profileField = (methods: readonly Integration.Method[] | undefined) =>
            methods?.find(
              (method): method is Integration.ExternalMethod =>
                method.type === "external" && method.id === "aws-profile",
            )?.form?.[0]

          expect(reads).toEqual({ streamed: [], whole: [] })
          expect(profileField(listed?.methods)).toMatchObject({ key: "profile", custom: true })
          expect(profileField(listed?.methods)).not.toHaveProperty("options")

          const requested = yield* integrations.get(integrationID)
          expect(profileField(requested?.methods)).toMatchObject({
            description: "Found 3 profiles in your AWS configuration.",
            options: ["default", "static", "work"].map((profile) => ({ value: profile, label: profile })),
          })
          expect(reads.streamed.toSorted()).toEqual([config, credentials])
          expect(reads.whole).toEqual([])
          for (const secret of ["AKIAEXAMPLE", "credentials-secret", "config-secret"])
            expect(JSON.stringify(requested)).not.toContain(secret)
        }),
      )
    }),
  )

  it.effect("leaves activation on auto without ambient AWS configuration", () =>
    withEnv(noAmbientAWS, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock()
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).activation).toBe("auto")
      }),
    ),
  )

  for (const name of Object.keys(noAmbientAWS).filter((name) => !name.includes("REGION"))) {
    it.effect(`enables the provider when ${name} is set`, () =>
      withEnv({ ...noAmbientAWS, [name]: "value" }, () =>
        Effect.gen(function* () {
          const catalog = yield* seedBedrock()
          yield* addPlugin()
          expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).activation).toBe("enabled")
        }),
      ),
    )
  }

  it.effect("enables the provider when a profile is configured", () =>
    withEnv(noAmbientAWS, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock({ profile: "work" })
        yield* addPlugin()
        const result = required(yield* catalog.get(Provider.ID.amazonBedrock))
        expect(result.activation).toBe("enabled")
        expect(result.settings).toEqual({ profile: "work", region: "us-east-1" })
      }),
    ),
  )

  it.effect("does not override a disabled provider", () =>
    withEnv({ ...noAmbientAWS, AWS_PROFILE: "work" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Provider.Service
        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.amazonBedrock, (item) => {
            item.package = "@opencode/ai/providers/amazon-bedrock"
            item.activation = "disabled"
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).activation).toBe("disabled")
      }),
    ),
  )

  it.effect("fills region from AWS_REGION then AWS_DEFAULT_REGION without overriding config", () =>
    withEnv({ ...noAmbientAWS, AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "us-west-2" }, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock()
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).settings).toEqual({
          region: "eu-west-1",
        })

        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.amazonBedrock, (item) => {
            item.settings = { region: "ap-southeast-2" }
          })
        })
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).settings).toEqual({
          region: "ap-southeast-2",
        })
      }),
    ),
  )

  it.effect("falls back to AWS_DEFAULT_REGION then us-east-1", () =>
    withEnv({ ...noAmbientAWS, AWS_DEFAULT_REGION: "us-west-2" }, () =>
      Effect.gen(function* () {
        const catalog = yield* seedBedrock()
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.amazonBedrock)).settings).toEqual({
          region: "us-west-2",
        })
        const fallback = yield* Effect.gen(function* () {
          yield* catalog.reload()
          return required(yield* catalog.get(Provider.ID.amazonBedrock)).settings
        }).pipe((fx) => withEnv({ AWS_DEFAULT_REGION: undefined }, () => fx))
        expect(fallback).toEqual({ region: "us-east-1" })
      }),
    ),
  )

  it.effect("applies to Mantle and native Bedrock packages", () =>
    withEnv({ ...noAmbientAWS, AWS_PROFILE: "work" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Provider.Service
        yield* catalog.transform((catalog) => {
          catalog.update(Provider.ID.make("mantle"), (item) => {
            item.package = "@opencode/ai/providers/amazon-bedrock/mantle/responses"
          })
          catalog.update(Provider.ID.make("native"), (item) => {
            item.package = "@opencode/ai/providers/amazon-bedrock"
          })
          catalog.update(Provider.ID.make("other"), (item) => {
            item.package = "@opencode/ai/providers/anthropic"
          })
        })
        yield* addPlugin()
        expect(required(yield* catalog.get(Provider.ID.make("mantle"))).activation).toBe("enabled")
        expect(required(yield* catalog.get(Provider.ID.make("native"))).activation).toBe("enabled")
        expect(required(yield* catalog.get(Provider.ID.make("other"))).activation).toBe("auto")
      }),
    ),
  )
})
