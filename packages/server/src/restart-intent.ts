export * as RestartIntent from "./restart-intent"

import { ServiceEvent } from "@opencode/schema/service-event"
import { Context, Effect, Layer, Ref } from "effect"

type Settlement = { readonly winner: ServiceEvent.Decision; readonly fresh: boolean } | undefined
type IntentState = { readonly pending: boolean; readonly last?: ServiceEvent.Decision }

export class Service extends Context.Service<Service, {
  /** Record a pending intent unless one exists. */
  readonly request: () => Effect.Effect<void>
  /**
   * Resolve the pending intent with first-wins semantics. Returns the winning
   * decision and whether this call settled it; late resolvers replay the
   * winner without rebroadcasting. Returns undefined when no intent exists.
   */
  readonly resolve: (decision: ServiceEvent.Decision) => Effect.Effect<Settlement>
}>()("@opencode/server/RestartIntent") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make<IntentState>({ pending: false })
    return Service.of({
      request: () => Ref.update(state, (current) => (current.pending ? current : { pending: true })),
      resolve: (decision) =>
        Ref.modify(state, (current): readonly [Settlement, IntentState] => {
          if (!current.pending) {
            return current.last === undefined
              ? [undefined, current]
              : [{ winner: current.last, fresh: false }, current]
          }
          return [{ winner: decision, fresh: true }, { pending: false, last: decision }]
        }),
    })
  }),
)
