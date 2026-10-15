export * as ModelDefault from "./model-default.js"

// Model ID fragments in ascending preference. Without this, a fresh install defaults to whichever
// model was released most recently, such as a newly launched free or stealth model.
const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]

/** Picks the fallback default model, preferring the internal priority and then the caller's order. */
export function pick<T extends { readonly id: string }>(models: readonly T[]) {
  const rank = (model: T) => priority.findIndex((item) => model.id.includes(item))
  return models.reduce<T | undefined>(
    (best, model) => (best === undefined || rank(model) > rank(best) ? model : best),
    undefined,
  )
}
