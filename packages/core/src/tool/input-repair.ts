/** Conservative recovery for provider-serialized tool arguments; called only after validation fails. */
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const repair = (value: unknown, schema: unknown): unknown => {
  if (!record(schema)) return value
  if (typeof value === "string" && schema.type === "object") {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return repair(parsed, schema)
    } catch { /* A malformed object remains a validation error. */ }
    return value
  }
  if (!record(value) || !record(schema.properties)) return value
  let changed = false
  const output: Record<string, unknown> = { ...value }
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!(key in output) || !record(property)) continue
    const current = output[key]
    if (current === null && !(Array.isArray(schema.required) && schema.required.includes(key)) &&
        typeof property.type === "string" && property.type !== "null" &&
        !("anyOf" in property) && !("oneOf" in property) && !("nullable" in property)) {
      delete output[key]
      changed = true
      continue
    }
    if (typeof current !== "string") continue
    if ((property.type === "integer" || property.type === "number") && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(current)) {
      const number = Number(current)
      if (Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number)) &&
          (property.type !== "integer" || Number.isSafeInteger(number))) {
        output[key] = number
        changed = true
      }
    } else if (property.type === "boolean" && (current === "true" || current === "false")) {
      output[key] = current === "true"
      changed = true
    } else if (property.type === "object" || property.type === "array") {
      try {
        const parsed: unknown = JSON.parse(current)
        if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed) === (property.type === "array")) {
          output[key] = parsed
          changed = true
        }
      } catch { /* Leave invalid JSON to normal schema validation. */ }
    }
  }
  return changed ? output : value
}
