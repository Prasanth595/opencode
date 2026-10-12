export function contextSelection(variant?: string, variants: readonly string[] = []) {
  const index =
    variant && !variants.includes(variant) && /@(default|long)$/.test(variant) ? variant.lastIndexOf("@") : -1
  return {
    effort: index < 0 ? variant : variant?.slice(0, index),
    tier: variant?.endsWith("@long") ? ("long" as const) : ("default" as const),
  }
}

export function selectModelVariant(
  current: string | undefined,
  next: string | undefined,
  variants: readonly string[],
  context = false,
) {
  if (!context || (next && !variants.includes(next) && /@(default|long)$/.test(next))) return next
  return `${next ?? "default"}@${contextSelection(current).tier}`
}

export function isModelVariantAvailable(variant: string | undefined, variants: readonly string[], context = false) {
  if (variant === undefined || variant === "default" || variants.includes(variant)) return true
  if (!context || !/@(default|long)$/.test(variant)) return false
  const effort = contextSelection(variant).effort
  return effort === "default" || (effort !== undefined && variants.includes(effort))
}
