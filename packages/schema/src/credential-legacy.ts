export * as CredentialLegacy from "./credential-legacy.js"

/**
 * Storage and wire compatibility for credentials written before v2.1 (not V1 contracts). Key credentials then kept
 * their setup-form answers in `configuration`; they now live in `metadata` like every other credential type. Stored
 * rows and exported credentials keep whichever shape they were written with, so this upgrades them before decoding.
 */
export function value(input: unknown) {
  if (!isRecord(input) || input.type !== "key" || !("configuration" in input)) return input
  const { configuration, ...rest } = input
  if (!isRecord(configuration)) return rest
  // Form answers overrode metadata when both reached provider settings, so they keep precedence here.
  return { ...rest, metadata: { ...(isRecord(rest.metadata) ? rest.metadata : {}), ...configuration } }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
