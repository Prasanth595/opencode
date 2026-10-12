// Model variant resolution and persistence.
//
// Variants are provider-specific reasoning effort levels (e.g., "high", "max").
// Resolution priority: CLI --variant flag > valid session history > saved preference.
//
// The saved variant persists across sessions in ~/.local/state/opencode/model.json
// so your last-used variant sticks. Cycling (ctrl+t) updates both the active
// variant and the persisted file.
import { createSession, sessionVariant, type RunSession, type SessionMessages } from "./session.shared"
import type { RunInput, RunProvider } from "./types"
import { cycleModelVariant, normalizeModelVariant } from "../model-preference"
import { contextSelection } from "../util/context"
import { isModelVariantAvailable, selectModelVariant } from "@opencode/util/model-variant"

export function modelInfo(providers: RunProvider[] | undefined, model: NonNullable<RunInput["model"]>) {
  const provider = providers?.find((item) => item.id === model.providerID)
  return {
    provider: provider?.name ?? model.providerID,
    model: provider?.models[model.modelID]?.name ?? model.modelID,
  }
}

export function formatModelLabel(
  model: NonNullable<RunInput["model"]>,
  variant: string | undefined,
  providers?: RunProvider[],
): string {
  const names = modelInfo(providers, model)
  const info = providers?.find((provider) => provider.id === model.providerID)?.models[model.modelID]
  const selection = info?.context ? contextSelection(variant, Object.keys(info.variants ?? {})) : undefined
  const value = selection
    ? [normalizeModelVariant(selection.effort), `${selection.tier} context`].filter(Boolean).join(" · ")
    : variant
  const label = value ? ` · ${value}` : ""
  return `${names.model} · ${names.provider}${label}`
}

export function cycleVariant(current: string | undefined, variants: string[], context = false): string | undefined {
  if (context) {
    const selection = contextSelection(current, variants)
    const effort = cycleModelVariant(selection.effort, variants)
    return `${effort ?? "default"}@${selection.tier}`
  }
  return cycleModelVariant(current, variants)
}

export function selectVariant(
  current: string | undefined,
  next: string | undefined,
  context: boolean,
  variants: string[] = [],
) {
  return selectModelVariant(current, next, variants, context)
}

export function pickVariant(model: RunInput["model"], input: RunSession | SessionMessages): string | undefined {
  return sessionVariant(Array.isArray(input) ? createSession(input) : input, model)
}

export function fitVariant(value: string | undefined, variants: string[], context = false): string | undefined {
  const normalized = normalizeModelVariant(value)
  return normalized &&
    (context
      ? isModelVariantAvailable(normalized, variants, true)
      : variants.length === 0 || variants.includes(normalized))
    ? normalized
    : undefined
}

export function variantOptions(variants: string[], context = false) {
  if (!context) return variants
  return [
    ...new Set([
      ...variants,
      ...["default", "long"].flatMap((tier) => ["default", ...variants].map((effort) => `${effort}@${tier}`)),
    ]),
  ]
}

// Picks the active variant. CLI flag wins, then valid session history, then the
// saved preference. Saved and session values are dropped when the provider no
// longer offers them.
export function resolveVariant(
  input: string | undefined,
  session: string | undefined,
  saved: string | undefined,
  variants: string[],
  context = false,
): string | undefined {
  if (input !== undefined) {
    return normalizeModelVariant(input)
  }

  return fitVariant(session, variants, context) ?? fitVariant(saved, variants, context)
}
