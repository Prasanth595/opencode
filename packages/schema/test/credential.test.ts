import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Credential } from "../src/credential.js"

const decode = Schema.decodeUnknownSync(Credential.Value)
const encode = Schema.encodeSync(Credential.Value)

describe("Credential.Key", () => {
  test("decodes form answers written to configuration before v2.1 into metadata, keeping answers first", () => {
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
    expect(decode({ type: "key", key: "secret", configuration: { resourceName: "answered" } })).toEqual({
      type: "key",
      key: "secret",
      metadata: { resourceName: "answered" },
    })
  })

  test("never encodes configuration", () => {
    const key = Credential.Key.make({ type: "key", key: "secret", metadata: { resourceName: "answered" } })
    expect(encode(key)).toEqual({ type: "key", key: "secret", metadata: { resourceName: "answered" } })
    expect(encode(decode({ type: "key", key: "secret", configuration: { resourceName: "answered" } }))).toEqual({
      type: "key",
      key: "secret",
      metadata: { resourceName: "answered" },
    })
  })

  test("still rejects invalid legacy configuration", () => {
    expect(() => decode({ type: "key", key: "secret", configuration: "answered" })).toThrow()
    expect(() => decode({ type: "key", key: "secret", metadata: [1], configuration: { a: "b" } })).toThrow()
  })
})
