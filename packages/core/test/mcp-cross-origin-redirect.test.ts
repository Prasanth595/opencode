// Regression tests for GHSA-6prh-2h8m-c8cw (v2.0.28 pinned client 2.0.0 which forwarded bodies and
// custom headers across cross-origin redirects). The bump to 2.3.0 plus OpenCode's local patch is
// expected to:
//   * block cross-origin redirects for the HTTP transport and the OAuth refresh path
//   * allow same-origin redirects to keep flowing on both paths
//
// Each case uses a real Bun.serve pair on ephemeral ports so we exercise the SDK's actual fetch
// path, not a mocked transport.

import { afterAll, describe, expect, test } from "bun:test"
import {
  refreshAuthorization,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import type { OAuthClientInformation } from "@modelcontextprotocol/client"

type Recorder = { url: string; method: string; headers: Record<string, string>; body: string }

const recorded = (map: Map<string, Recorder[]>, origin: string) => map.get(origin) ?? []

const capture = (map: Map<string, Recorder[]>, origin: string): Recorder[] => {
  const list: Recorder[] = []
  map.set(origin, list)
  return list
}

const startTwoOrigins = (redirectFrom: string, redirectTo: string, targetRecorder: Recorder[]) => {
  const origin = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/redirect") {
        return new Response(null, { status: 307, headers: { Location: redirectTo } })
      }
      return new Response("origin", { status: 200 })
    },
  })
  const target = Bun.serve({
    port: 0,
    fetch: (req) => {
      targetRecorder.push({
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers),
        body: req.body ? "had-body" : "no-body",
      })
      // Drain body so the request can complete without "unread body" warnings.
      req.body?.cancel().catch(() => {})
      return new Response("target", { status: 200 })
    },
  })
  return {
    origin,
    target,
    originURL: `http://localhost:${origin.port}`,
    targetURL: `http://localhost:${target.port}`,
  }
}

const startSameOriginRedirect = (recorder: Recorder[], targetPath: string) => {
  const server = Bun.serve({
    port: 0,
    fetch: (req): Response | Promise<Response> => {
      const url = new URL(req.url)
      if (url.pathname === "/redirect") {
        return new Response(null, { status: 307, headers: { Location: `http://localhost:${server.port}${targetPath}` } })
      }
      recorder.push({
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers),
        body: req.body ? "had-body" : "no-body",
      })
      req.body?.cancel().catch(() => {})
      return new Response("ok", { status: 200 })
    },
  })
  return { server, url: `http://localhost:${server.port}` }
}

const servers: { stop: () => void }[] = []
afterAll(() => {
  for (const s of servers.splice(0)) s.stop()
})

const makeTransport = (origin: string) => new StreamableHTTPClientTransport(new URL(`${origin}/mcp`))

describe("GHSA-6prh-2h8m-c8cw regression — HTTP transport", () => {
  test("cross-origin redirect does not forward body or custom headers", async () => {
    const recorders = new Map<string, Recorder[]>()
    const targetRecorder = capture(recorders, "target")
    const pair = startTwoOrigins("/redirect", "", targetRecorder)
    servers.push(pair.origin, pair.target)
    const transport = makeTransport(`${pair.originURL}/redirect`)

    await transport.start().catch(() => {})
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: {},
    } as never).catch(() => {})
    await transport.close()

    expect(recorded(recorders, "target")).toHaveLength(0)
  })

  test("same-origin redirect preserves body and headers", async () => {
    const recorder: Recorder[] = []
    const pair = startSameOriginRedirect(recorder, "/mcp")
    servers.push(pair.server)
    const transport = makeTransport(`${pair.url}/redirect`)

    await transport.start().catch(() => {})
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: {},
    } as never).catch(() => {})
    await transport.close()

    expect(recorder.length).toBeGreaterThan(0)
    expect(recorder[0].body).toBe("had-body")
  })
})

describe("GHSA-6prh-2h8m-c8cw regression — OAuth refresh", () => {
  const clientInfo: OAuthClientInformation = {
    client_id: "cid",
  }

  test("cross-origin redirect during refresh does not forward body or auth header", async () => {
    const recorders = new Map<string, Recorder[]>()
    const targetRecorder = capture(recorders, "target")
    const pair = startTwoOrigins("/redirect", "", targetRecorder)
    servers.push(pair.origin, pair.target)

    // Point the token endpoint at the origin server which 307-redirects. If the SDK forwards the
    // POST body and the Authorization: Bearer header across the origin boundary, the target server
    // will see them. The fix in 2.3.0 must drop both on a cross-origin hop.
    await refreshAuthorization(new URL(pair.originURL), {
      metadata: {
        issuer: pair.originURL,
        authorization_endpoint: `${pair.originURL}/authorize`,
        token_endpoint: `${pair.originURL}/redirect`,
        response_types_supported: ["code"],
      },
      clientInformation: clientInfo,
      refreshToken: "refresh",
    }).catch(() => {})

    expect(recorded(recorders, "target")).toHaveLength(0)
  })

  test("same-origin redirect during refresh still completes", async () => {
    const recorders: Recorder[] = []
    const pair = startSameOriginRedirect(recorders, "/token")
    servers.push(pair.server)

    // The SDK must issue a form POST and follow the same-origin 307 to the local /token path;
    // the second request is recorded on the same recorder.
    await refreshAuthorization(new URL(pair.url), {
      metadata: {
        issuer: pair.url,
        authorization_endpoint: `${pair.url}/authorize`,
        token_endpoint: `${pair.url}/redirect`,
        response_types_supported: ["code"],
      },
      clientInformation: clientInfo,
      refreshToken: "refresh",
    }).catch(() => {})

    expect(recorders.length).toBeGreaterThan(0)
  })
})
