import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import "./session-outline.css"

export type OutlineItem = {
  id: string
  title: string
  subtitle?: string
}

const TICK_H = 9 // px, one row per tick
const GAP_MAX = 7 // px, spacing when there is room
const RAIL_MAX_RATIO = 0.72 // share of the message area height the group may use
// Tick length is CSS-driven: `.session-outline-bar` is 10px and only the exact
// tick under the pointer (`.session-outline-tick:hover`) swells. Keeping it out
// of JS guarantees every tick is identical whenever the pointer is off the rail.

// A Codex-style conversation navigator pinned just inside the right edge: a
// compact, vertically-centered column of ticks (one per user turn). Ticks are
// even by default; moving the cursor across the rail makes them swell like a
// wind chime, and the current turn stays the longest. Clicking jumps to a turn.
export function SessionOutline(props: {
  scroller: () => HTMLDivElement | undefined
  items: () => OutlineItem[]
  onJump: (id: string) => void
}) {
  const [active, setActive] = createSignal<string>()
  const [hover, setHover] = createSignal<number>()
  // Keep the last hovered index so the card can animate out in place instead of
  // jumping back to the first tick.
  const [last, setLast] = createSignal<number>()
  const [gap, setGap] = createSignal(GAP_MAX)
  const [tickH, setTickH] = createSignal(TICK_H)
  const [cardY, setCardY] = createSignal(0)

  let railRef: HTMLDivElement | undefined
  const tickRefs: (HTMLButtonElement | undefined)[] = []

  const measure = () => {
    const root = props.scroller()
    if (!root) return
    const box = root.getBoundingClientRect()
    const line = box.top + 100
    // Every row of a turn carries the same `data-message-id`; merge them into one
    // span per turn so the hit test treats a whole turn as one block.
    const spans = new Map<string, { top: number; bottom: number }>()
    for (const el of root.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const id = el.dataset.messageId
      if (!id) continue
      const rect = el.getBoundingClientRect()
      const prev = spans.get(id)
      spans.set(id, {
        top: prev ? Math.min(prev.top, rect.top) : rect.top,
        bottom: prev ? Math.max(prev.bottom, rect.bottom) : rect.bottom,
      })
    }
    const list = [...spans.entries()].map(([id, span]) => ({ id, ...span }))
    if (list.length === 0) return
    const hit = list.find((item) => item.top <= line && item.bottom >= line)
    const above = list.filter((item) => item.top <= line).at(-1)
    const next = hit?.id ?? above?.id ?? list[0]?.id
    if (next) setActive(next)
  }

  // Fit the whole group inside the available height: shrink the gap first, then
  // the row height, so even very long sessions stay compact and centered.
  const resize = () => {
    const count = props.items().length
    const available = (railRef?.parentElement?.clientHeight ?? 600) * RAIL_MAX_RATIO
    if (count <= 1) {
      setTickH(TICK_H)
      setGap(GAP_MAX)
      return
    }
    const height = Math.min(TICK_H, available / count)
    setTickH(height)
    const ideal = (available - count * height) / (count - 1)
    setGap(Math.max(0, Math.min(GAP_MAX, ideal)))
  }

  onMount(() => {
    const parent = railRef?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(() => resize())
    observer.observe(parent)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    props.items().length
    resize()
  })

  createEffect(() => {
    let disposed = false
    let scrollFrame: number | undefined
    let retryFrame: number | undefined
    let root: HTMLDivElement | undefined
    const schedule = () => {
      if (scrollFrame !== undefined) return
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = undefined
        measure()
      })
    }
    // The scroller ref is a plain variable (not a signal), so poll a few frames
    // until the message timeline has mounted and handed it over.
    const attach = () => {
      if (disposed) return
      const next = props.scroller()
      if (!next) {
        retryFrame = requestAnimationFrame(attach)
        return
      }
      root = next
      root.addEventListener("scroll", schedule, { passive: true })
      schedule()
    }
    attach()
    onCleanup(() => {
      disposed = true
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
      if (retryFrame !== undefined) cancelAnimationFrame(retryFrame)
      root?.removeEventListener("scroll", schedule)
    })
  })

  createEffect(() => {
    if (hover() !== undefined) setLast(hover())
  })

  // Backstop: the moment the pointer leaves the rail rectangle, drop the hover so
  // no tick keeps its swollen length when the cursor is elsewhere.
  createEffect(() => {
    if (hover() === undefined) return
    const onMove = (event: PointerEvent) => {
      const rect = railRef?.getBoundingClientRect()
      if (!rect) return
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        setHover(undefined)
      }
    }
    document.addEventListener("pointermove", onMove, { passive: true })
    onCleanup(() => document.removeEventListener("pointermove", onMove))
  })

  // Drop the highlight if the active turn is gone (session switch / revert).
  createEffect(() => {
    const id = active()
    if (id && !props.items().some((item) => item.id === id)) setActive(undefined)
  })

  const target = () => hover() ?? last()
  const shown = createMemo(() => {
    const index = target()
    return index === undefined ? undefined : props.items()[index]
  })

  // Align the card to the hovered tick's real position within the rail.
  createEffect(() => {
    const index = target()
    const el = index === undefined ? undefined : tickRefs[index]
    if (!el) return
    const y = el.offsetTop + el.offsetHeight / 2
    // Keep the card off the top/bottom edges so it isn't clipped by the pane.
    const height = railRef?.parentElement?.clientHeight
    const half = 72
    setCardY(height && height > half * 2 ? Math.min(Math.max(y, half), height - half) : y)
  })

  // Track the cursor continuously across the whole rail so the wind-chime swell
  // is smooth and never flickers on the gaps between ticks.
  const onMove = (event: MouseEvent) => {
    if (!railRef) return
    const count = props.items().length
    if (count === 0) return
    const rect = railRef.getBoundingClientRect()
    const step = tickH() + gap()
    const index = Math.round((event.clientY - rect.top - tickH() / 2) / step)
    setHover(Math.max(0, Math.min(count - 1, index)))
  }

  return (
    <Show when={props.items().length >= 2}>
      <div class="session-outline">
        <div
          ref={(el) => {
            railRef = el
            queueMicrotask(resize)
          }}
          class="session-outline-rail"
          style={{ gap: `${gap()}px` }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(undefined)}
        >
          <For each={props.items()}>
            {(item, index) => (
              <button
                type="button"
                ref={(el) => (tickRefs[index()] = el)}
                class="session-outline-tick"
                classList={{ "is-active": active() === item.id }}
                style={{ height: `${tickH()}px` }}
                aria-label={item.title}
                onClick={(event) => {
                  props.onJump(item.id)
                  setHover(undefined)
                  event.currentTarget.blur()
                }}
              >
                <span class="session-outline-bar" />
              </button>
            )}
          </For>
          <div
            class="session-outline-card"
            classList={{ "is-open": hover() !== undefined }}
            style={{ top: `${cardY()}px` }}
          >
            <div class="session-outline-title">{shown()?.title}</div>
            <Show when={shown()?.subtitle}>
              <div class="session-outline-subtitle">{shown()?.subtitle}</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
