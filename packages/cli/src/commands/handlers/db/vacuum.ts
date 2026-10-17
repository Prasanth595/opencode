import { Service } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem, Option, Schema } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"
import { databasePath } from "../../../database-path"
import { errorMessage } from "../../../util/error"
import { compactDatabase } from "./maintenance"

const handler = Effect.fn("cli.db.vacuum")(function* (_input: Runtime.Input<typeof Commands.commands.db.commands.vacuum>) {
  const serviceOptions = yield* ServiceConfig.options()
  const fs = yield* FileSystem.FileSystem
  const registration = yield* fs.readFileString(serviceOptions.file).pipe(Effect.option)
  if (Option.isSome(registration)) {
    const info = Schema.decodeUnknownOption(Schema.fromJsonString(Service.Info))(registration.value)
    if (Option.isNone(info)) throw new Error("Cannot verify the background service registration; inspect service.json first.")
    const incumbent = yield* Service.incumbent({ ...serviceOptions, url: info.value.url })
    if (incumbent) throw new Error(`Stop the background service before vacuuming the database (PID ${info.value.pid}).`)
    if (processIsRunning(info.value.pid))
      throw new Error(
        `Cannot verify the registered service is stopped because PID ${info.value.pid} is still running; stop it or verify and remove a stale service registration.`,
      )
  }

  const global = yield* Global.Service
  const result = yield* Effect.try({
    try: () => compactDatabase(databasePath(global.data)),
    catch: (cause) => cause,
  })

  const reclaimed = Math.max(0, result.beforeBytes - result.afterBytes)
  process.stdout.write(`Database vacuum complete; reclaimed ${(reclaimed / 1024 / 1024).toFixed(1)} MiB.${EOL}`)
})

export default Runtime.handler(Commands.commands.db.commands.vacuum, (input) =>
  handler(input).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        process.stderr.write(errorMessage(error) + EOL)
        process.exitCode = 1
      }),
    ),
  ),
)

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined
    return code !== "ESRCH"
  }
}
