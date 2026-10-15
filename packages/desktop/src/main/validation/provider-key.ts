import { ipcMain } from "electron"
import { ValidateProviderKeyChannel } from "../../shared/ipc-transport"
import { isRendererUrl } from "../windows/scheme"

export type ProviderKeyValidation = {
  valid: boolean
  reason?: "invalid_key" | "unreachable" | "unsupported"
}

// Probes the provider's own models endpoint to check whether a key is
// accepted, without storing it. Runs in the main process (Node) so there
// are no browser CORS restrictions.
// oxlint-disable-next-line anti-slop/no-known-value-widening -- open dictionary is the contract: unknown provider IDs must miss, not fail to compile
const keyProbes: Record<string, { url: (key: string) => string; headers: (key: string) => Record<string, string> }> = {
  anthropic: {
    url: () => "https://api.anthropic.com/v1/models",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  },
  openai: {
    url: () => "https://api.openai.com/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  google: {
    url: (key) => `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    headers: () => ({}),
  },
}

export function registerValidateProviderKeyHandler() {
  // SAFETY: Electron delivers untrusted IPC arguments; the shape is validated below before use.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- see SAFETY above
  ipcMain.handle(ValidateProviderKeyChannel, async (event, input: unknown): Promise<ProviderKeyValidation> => {
    if (!isRendererUrl(event.senderFrame?.url)) return { valid: false, reason: "unreachable" }

    // SAFETY: the I/O boundary check below establishes the complete contract: a
    // non-null object whose providerID and key are both non-empty strings.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- see SAFETY above
    if (typeof input !== "object" || input === null) return { valid: false, reason: "unreachable" }
    // SAFETY: the typeof guards above established input as a non-null object.
    const { providerID, key } = input as { providerID?: unknown; key?: unknown }

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- see SAFETY above
    if (typeof providerID !== "string" || typeof key !== "string" || key.length === 0)
      return { valid: false, reason: "unreachable" }

    const probe = keyProbes[providerID]

    if (!probe) return { valid: false, reason: "unsupported" }

    let res: Response

    try {
      res = await fetch(probe.url(key), { headers: probe.headers(key), signal: AbortSignal.timeout(10000) })
    } catch {
      return { valid: false, reason: "unreachable" }
    }

    // 401/403 means the provider rejected the key. Anything else below 500
    // means the key was accepted (even 429: rate-limited, not invalid).
    if (res.status === 401 || res.status === 403) return { valid: false, reason: "invalid_key" }

    if (res.status < 500) return { valid: true }

    return { valid: false, reason: "unreachable" }
  })
}
