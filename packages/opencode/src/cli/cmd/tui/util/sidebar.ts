// Single clamped source for the session sidebar width. The sidebar component
// and the session content math both read this so the two cannot drift apart.
export const Default = 42
export const Min = 20
export const Max = 100
// Columns always reserved for the main pane when clamping.
export const Reserve = 40
// The drag rail occupies one column beside the sidebar.
export const Rail = 1

export function clamp(width: number, total: number) {
  // kv.json is hand-editable so junk must fall back instead of poisoning layout.
  if (!Number.isFinite(width)) return Default
  return Math.max(Min, Math.min(Math.round(width), total - Reserve, Max))
}

export function resolve(configured: number | undefined, total: number) {
  return clamp(configured ?? Default, total)
}
