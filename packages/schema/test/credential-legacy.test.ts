import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Credential } from "../src/credential.js"
import { CredentialLegacy } from "../src/credential-legacy.js"

const decode = (input: unknown) => Schema.decodeUnknownSync(Credential.Value)(CredentialLegacy.value(input))

describe("CredentialLegacy", () => {
  test("moves key form answers from configuration into metadata, keeping answers over older metadata", () => {
    expect(
      decode({
        type: "key",
        key: "secret",
        metadata: { imported: true, resourceName: "older" },
        configuration: { resourceName: "answered", accountId: "account" },
      }),
    ).toEqual({
      type: "key",
      key: "secret",
      metadata: { imported: true, resourceName: "answered", accountId: "account" },
    })
  })

  test("creates metadata when a key credential only had configuration", () => {
    expect(decode({ type: "key", key: "secret", configuration: { resourceName: "answered" } })).toEqual({
      type: "key",
      key: "secret",
      metadata: { resourceName: "answered" },
    })
  })

  test("leaves current and other credential values unchanged", () => {
    const key = { type: "key", key: "secret", metadata: { resourceName: "answered" } }
    expect(CredentialLegacy.value(key)).toBe(key)
    const external = { type: "external", methodID: "azure-cli", metadata: { resourceName: "answered" } }
    expect(CredentialLegacy.value(external)).toBe(external)
  })
})
