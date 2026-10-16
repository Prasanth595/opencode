export * as RestartIntent from "./restart-intent"

import { ServiceEvent } from "@opencode/schema/service-event"
import { Context, Effect, Layer, Ref } from "effect"

export class Service extends Context.Service<Service, {
  /** Record a pending intent unless one exists. */
  readonly request: () => Effect.Effect<void>
  /**
   * Resolve the pending intent with first-wins semantics. Returns the winning
   * decision, or undefined when no intent is pending.
   */
  readonly resolve: (decision: ServiceEvent.Decision) => Effect.Effect<ServiceEvent.Decision | undefined>
}>()("@opencode/server/RestartIntent") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make<{ readonly pending: boolean; readonly last?: ServiceEvent.Decision }>({
      pending: false,
    })
    return Service.of({
      request: () => Ref.update(state, (current) => (current.pending ? current : { pending: true })),
      resolve: (decision) =>
        Ref.modify(state, (current) => {
          if (!current.pending) return [current.last, current] as const
          return [decision, { pending: false, last: decision }] as const
        }),
    })
  }),
)
