export * as TokenUsage from "./token-usage.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
  /** Provider-measured prompt size when billed input overstates it, such as a response continued across requests. */
  prompt: Schema.Finite.pipe(optional),
}).annotate({ identifier: "TokenUsage.Info" })

export function total(tokens: Info) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

/** Size of the prompt the step was generated from. */
export function prompt(tokens: Info) {
  return tokens.prompt ?? tokens.input + tokens.cache.read + tokens.cache.write
}

/** Context the step leaves behind: its prompt plus everything it generated. */
export function context(tokens: Info) {
  return prompt(tokens) + tokens.output + tokens.reasoning
}
