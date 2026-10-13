import { expect, test } from "bun:test"

const { install } = await import("../../../src/cli/cmd/tui/util/teardown")

test("install adds a terminal restore listener and removes it again", () => {
  const exit = process.listenerCount("exit")
  const term = process.listenerCount("SIGTERM")

  const uninstall = install()

  expect(process.listenerCount("exit")).toBe(exit + 1)
  expect(process.listenerCount("SIGTERM")).toBe(term + 1)

  uninstall()

  expect(process.listenerCount("exit")).toBe(exit)
  expect(process.listenerCount("SIGTERM")).toBe(term)
})
