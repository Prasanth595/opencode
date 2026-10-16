import { Config } from "effect"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// The opencode server password: sent by clients connecting to an explicit
// --server, and adopted by a manually run or standalone server. The legacy
// name is still honored.
export const password = Config.Redacted("OPENCODE_PASSWORD").pipe(
  Config.orElse(() => Config.Redacted("OPENCODE_SERVER_PASSWORD")),
  Config.withDefault(undefined),
)

export function session() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "OPENCODE_PASSWORD" && entry[0] !== "OPENCODE_SERVER_PASSWORD",
    ),
  )
}

// Managed service environment (`service set env`). The service owns its config, so a contender
// started without it (Desktop, a manual `serve --service`, a stale client) adopts it at boot.
// Managed values win, matching the spawn merge in `spawnServiceContender`.
export function adoptManaged(env: Readonly<Record<string, string>>) {
  Object.entries(env).forEach(([key, value]) => {
    process.env[key] = value
  })
}

export * as Env from "./env"
