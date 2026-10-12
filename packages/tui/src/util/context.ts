export function contextSelection(variant?: string) {
  const index = variant && /@(default|long)$/.test(variant) ? variant.lastIndexOf("@") : -1
  return {
    effort: index < 0 ? variant : variant?.slice(0, index),
    tier: variant?.endsWith("@long") ? ("long" as const) : ("default" as const),
  }
}
