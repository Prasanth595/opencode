import type { APIEvent } from "@solidjs/start/server"
import { ZenData } from "@opencode/console-core/model.js"
import { buildOptionsResponse, buildModelsResponse } from "~/routes/zen/util/modelsHandler"
import { inferenceUnavailable, proxyInference } from "~/lib/inference-proxy"

export async function OPTIONS(_input: APIEvent) {
  return buildOptionsResponse()
}

export async function GET(input: APIEvent) {
  const apiKey = input.request.headers.get("authorization")?.split(" ")[1]
  if (apiKey && apiKey !== "public") {
    const response = await proxyInference(input.request).catch(inferenceUnavailable)
    if (response) return response
  }

  const models = Object.keys(ZenData.list("full").models).filter((id) => !id.endsWith(":global"))

  return buildModelsResponse(models)
}
