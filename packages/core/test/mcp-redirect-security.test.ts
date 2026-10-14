import { expect, test } from "bun:test"
import { refreshAuthorization, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { McpOAuth } from "@opencode/core/mcp/oauth"
import { Effect } from "effect"

for (const sameOrigin of [false, true]) {
  test(`MCP redirect ${sameOrigin ? "within one origin is allowed" : "to another origin is blocked"}`, async () => {
    let received = 0
    const destination = Bun.serve({
      port: 0,
      fetch() {
        received++
        return Response.json({ jsonrpc: "2.0", id: 1, result: {} })
      },
    })
    const source = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/accepted") {
          received++
          expect(request.headers.get("X-Test-Credential")).toBe("synthetic-only")
          return Response.json({ jsonrpc: "2.0", id: 1, result: {} })
        }
        return new Response(null, {
          status: 307,
          headers: {
            location: sameOrigin ? new URL("/accepted", request.url).href : destination.url.href,
          },
        })
      },
    })
    const transport = new StreamableHTTPClientTransport(source.url, {
      requestInit: { headers: { "X-Test-Credential": "synthetic-only" } },
      fetch: await Effect.runPromise(McpOAuth.loggedFetch({ server: "redirect-test" })),
    })
    try {
      await transport.start()
      const sent = transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      if (sameOrigin) await sent
      else await expect(sent).rejects.toThrow()
      expect(received).toBe(sameOrigin ? 1 : 0)
    } finally {
      await transport.close()
      await source.stop(true)
      await destination.stop(true)
    }
  })

  test(`OAuth POST redirect ${sameOrigin ? "within one origin is allowed" : "to another origin is blocked"}`, async () => {
    let received = 0
    const destination = Bun.serve({
      port: 0,
      fetch() {
        received++
        return Response.json({ access_token: "synthetic-only", token_type: "Bearer" })
      },
    })
    const source = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/accepted") {
          received++
          expect(new URLSearchParams(await request.text()).get("refresh_token")).toBe("synthetic-only")
          return Response.json({ access_token: "synthetic-only", token_type: "Bearer" })
        }
        return new Response(null, {
          status: 307,
          headers: {
            location: sameOrigin ? new URL("/accepted", request.url).href : destination.url.href,
          },
        })
      },
    })
    try {
      const response = refreshAuthorization(source.url, {
        metadata: {
          issuer: source.url.origin,
          token_endpoint: new URL("/token", source.url).href,
          authorization_endpoint: new URL("/authorize", source.url).href,
          response_types_supported: ["code"],
        },
        clientInformation: { client_id: "synthetic-only" },
        refreshToken: "synthetic-only",
        fetchFn: await Effect.runPromise(McpOAuth.loggedFetch({ server: "redirect-test" })),
      })
      if (sameOrigin) expect((await response).access_token).toBe("synthetic-only")
      else await expect(response).rejects.toThrow()
      expect(received).toBe(sameOrigin ? 1 : 0)
    } finally {
      await source.stop(true)
      await destination.stop(true)
    }
  })
}
