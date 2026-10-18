import { describe, expect, test } from "bun:test"
import { footerWording } from "./update-preflight"

const words = (segments: ReadonlyArray<readonly [string, string, boolean?]>) => segments.map((segment) => segment[0])

describe("update preflight", () => {
  test("uses replacement wording when the replaced service is newer", () => {
    const downgrade = footerWording("2.0.32", "2.0.29")
    expect(words(downgrade.running)).toEqual(["OpenCode", "is replacing", "2.0.32", "with", "2.0.29"])
    expect(words(downgrade.completed)).toEqual(["OpenCode", "replaced", "2.0.32", "with", "2.0.29"])
    expect(words(downgrade.paused)).toEqual(["OpenCode", "replacement paused"])
  })

  test("keeps update wording for upgrades and missing services", () => {
    const upgrade = footerWording("2.0.29", "2.0.32")
    expect(words(upgrade.running)).toEqual(["OpenCode", "is updating", "from", "2.0.29", "to", "2.0.32"])
    expect(words(upgrade.completed)).toEqual(["OpenCode", "updated to", "2.0.32"])
    expect(words(upgrade.paused)).toEqual(["OpenCode", "update paused"])
    expect(words(footerWording(undefined, "2.0.32").running)).toEqual(["OpenCode", "is updating", "to", "2.0.32"])
  })

  test("treats a newer dev-channel service as a downgrade", () => {
    expect(words(footerWording("0.0.0-dev-17404", "0.0.0-dev-17403").running)).toEqual([
      "OpenCode",
      "is replacing",
      "0.0.0-dev-17404",
      "with",
      "0.0.0-dev-17403",
    ])
  })
})
