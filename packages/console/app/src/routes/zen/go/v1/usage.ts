import type { APIEvent } from "@solidjs/start/server"
import { inferenceUnavailable, proxyInference } from "~/lib/inference-proxy"

export async function GET(input: APIEvent) {
  const response = await proxyInference(input.request).catch(inferenceUnavailable)
  if (response) return response
  const apiKey = input.request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1]
  return Response.json(
    { type: "error", error: { type: "AuthError", message: apiKey ? "Unauthorized" : "Missing API key." } },
    { status: 401 },
  )
}
