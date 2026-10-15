import { Context, Duration, Effect, Exit, Layer, LayerMap, MutableHashMap, Option } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Instance } from "./instance.js"
import { Location } from "./location.js"
import { LocationLifecycle } from "./location-lifecycle.js"
import { LocationServiceMap } from "./location-service-map.js"

export { LocationServiceMap } from "./location-service-map.js"

export type LocationServices = Instance.Services

type Build = {
  close?: Effect.Effect<void>
  identity?: string
  probe?: Effect.Effect<string | undefined>
}

export function buildLocationServiceMap(
  replacements: LayerNode.Replacements = [],
): Layer.Layer<LocationServiceMap.Service> {
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const owner = yield* Effect.scope
      const builds = MutableHashMap.empty<Location.Ref, Build>()
      const inner: LayerMap.LayerMap<Location.Ref, LocationServices, Instance.Error> = yield* LayerMap.make(
        (ref: Location.Ref) => {
          const build: Build = {}
          MutableHashMap.set(builds, ref, build)
          return Layer.fromBuild((memoMap, scope) =>
            Effect.suspend(() =>
              Layer.buildWithMemoMap(Instance.layer(ref, { replacements: bindings }), memoMap, scope),
            ).pipe(
              Effect.onExit((exit) => {
                const finish = Effect.suspend(() => {
                  if (Exit.isSuccess(exit)) {
                    return Effect.gen(function* () {
                      const lifecycle = Context.get(exit.value, LocationLifecycle.Service)
                      // A boot detached while in flight still needs shutdown and cancellation.
                      if (Option.getOrUndefined(MutableHashMap.get(builds, ref)) !== build)
                        return yield* lifecycle.shutdown
                      build.close = lifecycle.shutdown
                      if (ref.workspaceID) return
                      build.probe = fs.stat(ref.directory).pipe(
                        Effect.map((info) => {
                          const inode = Option.getOrUndefined(info.ino)
                          const created = Option.getOrUndefined(info.birthtime)?.getTime()
                          if (inode === undefined && created === undefined) return undefined
                          return `${info.dev}:${inode}:${created}`
                        }),
                        // An unavailable local probe must not evict an otherwise healthy graph.
                        Effect.orElseSucceed(() => undefined),
                      )
                      build.identity = yield* build.probe
                    })
                  }
                  // An explicitly invalidated build must not evict its replacement.
                  if (Option.getOrUndefined(MutableHashMap.get(builds, ref)) !== build) return Effect.void
                  MutableHashMap.remove(builds, ref)
                  // Evict once per failed build, before its result reaches borrowers.
                  return Exit.isFailure(exit) ? inner.invalidate(ref) : Effect.void
                })
                // With no borrowers, invalidation closes the entry's scope and
                // joins this lookup fiber. Let the owner finish that cleanup.
                return Exit.isFailure(exit)
                  ? finish.pipe(Effect.forkIn(owner, { startImmediately: true }), Effect.asVoid)
                  : finish
              }),
            ),
          )
        },
        // Retain healthy graphs until explicit invalidation or a local directory
        // identity change. Boot failures still evict entries for retry.
        { idleTimeToLive: Duration.infinity },
      )
      const refresh = Effect.fn("LocationServiceMap.refresh")(function* (ref: Location.Ref) {
        const build = Option.getOrUndefined(MutableHashMap.get(builds, ref))
        if (!build?.probe || build.identity === undefined) return
        const identity = yield* build.probe
        if (identity === undefined || identity === build.identity) return
        // Another lookup or explicit invalidation may already have detached this graph.
        if (Option.getOrUndefined(MutableHashMap.get(builds, ref)) !== build) return
        yield* map.invalidate(ref)
      })
      const map = {
        ...inner,
        get: (ref: Location.Ref) => Layer.effectContext(map.contextEffect(ref)),
        contextEffect: (ref: Location.Ref) => {
          const key = LocationServiceMap.canonical(ref)
          return refresh(key).pipe(Effect.andThen(inner.contextEffect(key)))
        },
        contextEffectOption: (ref: Location.Ref) => {
          const key = LocationServiceMap.canonical(ref)
          return refresh(key).pipe(Effect.andThen(inner.contextEffectOption(key)))
        },
        invalidate: (ref: Location.Ref) =>
          Effect.suspend(() => {
            const key = LocationServiceMap.canonical(ref)
            const build = Option.getOrUndefined(MutableHashMap.get(builds, key))
            MutableHashMap.remove(builds, key)
            // Detach routing first, then cancel interactions and notify clients. Running
            // steps retain their borrowed graph until they can hand off at a boundary.
            // Do not await a boot here: failed/in-flight builds have their own cleanup path.
            return inner.invalidate(key).pipe(Effect.andThen(build?.close ?? Effect.void))
          }).pipe(Effect.uninterruptible),
      }
      // Cached instances borrow their owner instead of retaining its Layer scope.
      const bindings: LayerNode.Replacements = [
        Instance.node.replace(
          Layer.succeed(Instance.Service, {
            provide: (session) => Effect.provide(map.get(session.location)),
          }),
        ),
        ...replacements,
        LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
      ]
      return map
    }),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node, { replacements })))
}
