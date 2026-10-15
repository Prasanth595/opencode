export * as ModelDefault from "./model-default.js"

/**
 * Without an authenticated provider, only free OpenCode models are available and the newest one would
 * become the default, so each new free launch would become every fresh install's first model.
 * Returns big-pickle in that case and undefined otherwise, leaving the caller's fallback unchanged.
 */
export function freeOnly<T extends { readonly providerID: string; readonly id: string }>(
  models: readonly T[],
  free: (model: T) => boolean,
) {
  if (!models.every((model) => model.providerID === "opencode" && free(model))) return
  return models.find((model) => model.id === "big-pickle")
}
