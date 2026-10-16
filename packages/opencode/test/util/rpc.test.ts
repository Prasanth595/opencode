import { describe, expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"

describe("util.rpc", () => {
  test("delivers calls made while the worker is still in its top-level await", async () => {
    const worker = new Worker(new URL("../fixture/rpc-worker.ts", import.meta.url).href)
    try {
      const client = Rpc.client<{ echo: (input: string) => string }>(worker)
      await new Promise<void>((resolve) => client.on("started", () => resolve()))
      expect(await client.call("echo", "hello")).toBe("hello")
    } finally {
      worker.terminate()
    }
  })
})
