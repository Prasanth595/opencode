import { expect, test } from "bun:test"
import { Env } from "../src/env"

test("session environment omits server credentials", () => {
  const previousPassword = process.env.OPENCODE_PASSWORD
  const previousLegacyPassword = process.env.OPENCODE_SERVER_PASSWORD
  const previousValue = process.env.OPENCODE_SESSION_ENV_TEST
  process.env.OPENCODE_PASSWORD = "password"
  process.env.OPENCODE_SERVER_PASSWORD = "legacy"
  process.env.OPENCODE_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.OPENCODE_PASSWORD
  else process.env.OPENCODE_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = previousLegacyPassword
  if (previousValue === undefined) delete process.env.OPENCODE_SESSION_ENV_TEST
  else process.env.OPENCODE_SESSION_ENV_TEST = previousValue

  expect(environment.OPENCODE_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SERVER_PASSWORD).toBeUndefined()
  expect(environment.OPENCODE_SESSION_ENV_TEST).toBe("included")
})

test("adopted managed environment wins over ambient values", () => {
  const previousManaged = process.env.OPENCODE_ADOPT_ENV_TEST
  const previousAmbient = process.env.OPENCODE_ADOPT_ENV_AMBIENT
  const previousEmpty = process.env.OPENCODE_ADOPT_ENV_EMPTY
  process.env.OPENCODE_ADOPT_ENV_AMBIENT = "ambient"
  try {
    Env.adoptManaged({
      OPENCODE_ADOPT_ENV_TEST: "managed",
      OPENCODE_ADOPT_ENV_AMBIENT: "managed",
      OPENCODE_ADOPT_ENV_EMPTY: "",
    })
    expect(process.env.OPENCODE_ADOPT_ENV_TEST).toBe("managed")
    expect(process.env.OPENCODE_ADOPT_ENV_AMBIENT).toBe("managed")
    expect(process.env.OPENCODE_ADOPT_ENV_EMPTY).toBe("")
  } finally {
    if (previousManaged === undefined) delete process.env.OPENCODE_ADOPT_ENV_TEST
    else process.env.OPENCODE_ADOPT_ENV_TEST = previousManaged
    if (previousAmbient === undefined) delete process.env.OPENCODE_ADOPT_ENV_AMBIENT
    else process.env.OPENCODE_ADOPT_ENV_AMBIENT = previousAmbient
    if (previousEmpty === undefined) delete process.env.OPENCODE_ADOPT_ENV_EMPTY
    else process.env.OPENCODE_ADOPT_ENV_EMPTY = previousEmpty
  }
})
