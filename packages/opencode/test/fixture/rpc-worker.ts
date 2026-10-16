import { Rpc } from "../../src/util/rpc"

Rpc.emit("started", undefined)
await new Promise((resolve) => setTimeout(resolve, 300))

Rpc.listen({
  echo: (input: string) => input,
})
