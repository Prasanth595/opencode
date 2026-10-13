import { createInterface } from "node:readline"

// A protocol peer for testing process ownership without requiring a desktop.
for await (const line of createInterface({ input: process.stdin })) {
  await Bun.write(
    process.env.OPENCODE_CLIPBOARD_FIXTURE!,
    JSON.stringify({ pid: process.pid, text: JSON.parse(line), display: process.env.DISPLAY }),
  )
  process.stdout.write(Buffer.from([1]))
}
