type Artifact = {
  channel: string
  name: string
  distribution: string
  version: string
  metadata: Record<string, unknown>
}

// Publishes release metadata to the update service (services/update on dev) with a GitHub Actions OIDC token.
// The service only accepts the v1 channel from refs/heads/v1.
export namespace UpdateArtifact {
  export async function publish(artifact: Artifact) {
    if (process.env.GITHUB_ACTIONS !== "true") {
      console.log("skipped update artifact publication outside GitHub Actions")
      return
    }
    const requestURL = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    if (!requestURL || !requestToken) throw new Error("GitHub Actions OIDC is unavailable")

    const url = new URL(requestURL)
    url.searchParams.set("audience", "https://update.opencode.ai")
    const tokenResponse = await fetch(url, { headers: { Authorization: `Bearer ${requestToken}` } })
    if (!tokenResponse.ok) throw new Error(`Failed to request GitHub OIDC token: ${tokenResponse.status}`)
    const token: unknown = await tokenResponse.json()
    if (!isRecord(token) || typeof token.value !== "string")
      throw new Error("GitHub OIDC response did not include a token")

    for (const attempt of [0, 1, 2]) {
      const response = await fetch("https://opencode.ai/update/api/publish", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.value}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(artifact),
      })
      if (response.ok) return
      // D1 can commit the upsert and still time out. Replaying the same artifact is safe.
      if (response.status >= 500 && attempt < 2) {
        await response.arrayBuffer()
        console.warn(`Update artifact publication returned ${response.status}; retrying`)
        await Bun.sleep((attempt + 1) * 1_000)
        continue
      }
      throw new Error(`Failed to publish update artifact: ${response.status} ${await response.text()}`)
    }
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
