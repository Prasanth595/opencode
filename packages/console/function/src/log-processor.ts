import type { TraceItem } from "@cloudflare/workers-types"

export default {
  async tail(events: TraceItem[]) {
    for (const event of events) {
      if (!event.event) continue
      if (!("request" in event.event)) continue
      if (event.event.request.method !== "POST") continue

      const url = new URL(event.event.request.url)
      if (
        url.pathname !== "/zen/v1/chat/completions" &&
        url.pathname !== "/zen/v1/messages" &&
        url.pathname !== "/zen/v1/responses" &&
        !url.pathname.startsWith("/zen/v1/models/") &&
        url.pathname !== "/zen/go/v1/chat/completions" &&
        url.pathname !== "/zen/go/v1/messages" &&
        url.pathname !== "/zen/go/v1/responses" &&
        !url.pathname.startsWith("/zen/go/v1/models/")
      )
        continue

      const ip = event.event.request.headers["x-real-ip"]
      const data: Record<string, unknown> = {
        "cf.continent": event.event.request.cf?.continent,
        "cf.country": event.event.request.cf?.country,
        "cf.city": event.event.request.cf?.city,
        "cf.region": event.event.request.cf?.region,
        "cf.latitude": event.event.request.cf?.latitude,
        "cf.longitude": event.event.request.cf?.longitude,
        "cf.timezone": event.event.request.cf?.timezone,
        duration: event.wallTime,
        request_length: parseInt(event.event.request.headers["content-length"] ?? "0"),
        status: event.event.response?.status ?? 0,
        ip,
        "ip.prefix": ipPrefix(ip),
      }
      const metrics = event.logs.flatMap((log) =>
        log.message.flatMap((message: string) =>
          message.startsWith("_metric:") ? [JSON.parse(message.slice(8)) as Record<string, unknown>] : [],
        ),
      )
      console.log(JSON.stringify(Object.assign(data, ...metrics), null, 2))
    }
  },
}

// Returns a stable lookup key for an IP address.
// IPv4: full address as /32 (e.g. "203.0.113.45/32").
// IPv6: the /64 network prefix (e.g. "2001:db8:abcd:1234::/64"). ISPs commonly
// rotate the lower 64 host bits via SLAAC privacy extensions (RFC 8981), so
// grouping by /64 collapses those rotations into one key.
function ipPrefix(ip: string | undefined) {
  if (!ip) return undefined
  if (ip.includes(".") && !ip.includes(":")) return `${ip}/32`
  if (!ip.includes(":")) return undefined

  // Expand "::" to its full form, then keep the first 4 hextets.
  const [head, tail] = ip.split("::") as [string, string | undefined]
  const headParts = head ? head.split(":") : []
  const tailParts = tail !== undefined ? tail.split(":") : []
  const missing = 8 - headParts.length - tailParts.length
  if (missing < 0) return undefined
  const full = [...headParts, ...new Array(missing).fill("0"), ...tailParts]
  if (full.length !== 8) return undefined

  const prefix = full
    .slice(0, 4)
    .map((part) => part.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")
  return `${prefix}::/64`
}
