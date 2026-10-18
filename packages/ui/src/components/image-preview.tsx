import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { animate, type AnimationPlaybackControls } from "motion"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useI18n } from "../context/i18n"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { clampView, detailScale, FIT_VIEW, maxScale, panBy, wheelZoomFactor, zoomAt, type ZoomView } from "./image-zoom"

export interface ImagePreviewProps {
  src: string
  alt?: string
}

const STEP = Math.SQRT2

const CENTER = { x: 0, y: 0 }

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  let viewport!: HTMLDivElement
  let image!: HTMLImageElement
  let close: HTMLButtonElement | undefined
  const [view, setView] = createSignal(FIT_VIEW)
  const [fitRatio, setFitRatio] = createSignal(1)
  const [drag, setDrag] = createSignal<{ id: number; x: number; y: number }>()
  // Where an eased zoom is heading, so repeated steps build on the destination rather than the frame in flight.
  let goal = FIT_VIEW
  let animation: AnimationPlaybackControls | undefined

  const percent = createMemo(() => new Intl.NumberFormat(i18n.locale(), { style: "percent", maximumFractionDigits: 0 }))

  const bounds = () => ({
    width: image.offsetWidth,
    height: image.offsetHeight,
    viewportWidth: viewport.clientWidth,
    viewportHeight: viewport.clientHeight,
    maxScale: maxScale(fitRatio()),
  })

  // Pinch, wheel and drag follow the hand directly and take over from an eased zoom mid-flight.
  const follow = (next: ZoomView) => {
    animation?.stop()
    animation = undefined
    goal = next
    setView(next)
  }

  const ease = (target: ZoomView) => {
    animation?.stop()
    goal = target

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setView(target)
    const from = view()
    animation = animate(0, 1, {
      type: "spring",
      visualDuration: 0.25,
      bounce: 0,
      onUpdate: (progress) =>
        setView({
          scale: from.scale + (target.scale - from.scale) * progress,
          x: from.x + (target.x - from.x) * progress,
          y: from.y + (target.y - from.y) * progress,
        }),
    })
  }

  const step = (factor: number) => ease(zoomAt(goal, goal.scale * factor, CENTER, bounds()))

  const point = (event: MouseEvent) => {
    const rect = viewport.getBoundingClientRect()

    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
  }

  const measure = () => {
    if (!image.naturalWidth) return
    setFitRatio(image.offsetWidth / image.naturalWidth)
    follow(clampView(view(), bounds()))
  }

  createResizeObserver(() => [viewport, image], measure)

  createEffect(
    on(
      () => props.src,
      () => follow(FIT_VIEW),
      { defer: true },
    ),
  )

  onCleanup(() => animation?.stop())

  // The preview owns zoom gestures while it is open: the page behind must neither scroll nor zoom the whole window.
  makeEventListener(
    window,
    "wheel",
    (event: WheelEvent) => {
      const inside = event.target instanceof Node && viewport.contains(event.target)
      const zoom = event.ctrlKey || event.metaKey

      if (!inside && !zoom) return
      event.preventDefault()
      event.stopPropagation()

      if (!inside) return
      const current = view()

      if (zoom) {
        follow(zoomAt(current, current.scale * wheelZoomFactor(pixels(event, event.deltaY)), point(event), bounds()))

        return
      }

      const horizontal = event.shiftKey && event.deltaX === 0
      follow(
        panBy(
          current,
          {
            x: -pixels(event, horizontal ? event.deltaY : event.deltaX),
            y: horizontal ? 0 : -pixels(event, event.deltaY),
          },
          bounds(),
        ),
      )
    },
    { passive: false, capture: true },
  )

  // Captured ahead of the desktop shell, which zooms the whole window on the same shortcuts.
  makeEventListener(
    window,
    "keydown",
    (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const action = shortcut(event.key)

      if (!action) return
      event.preventDefault()
      event.stopPropagation()

      if (action === "fit") return ease(FIT_VIEW)
      step(action === "in" ? STEP : 1 / STEP)
    },
    { capture: true },
  )

  return (
    <div data-component="image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content
          data-slot="image-preview-content"
          onOpenAutoFocus={(event) => {
            // Open with focus on Close, as before, rather than on the zoom controls that now precede it.
            event.preventDefault()
            close?.focus()
          }}
        >
          <div data-slot="image-preview-header">
            <div data-slot="image-preview-zoom">
              <IconButton
                data-slot="image-preview-zoom-out"
                icon={<Icon name="minus" />}
                variant="ghost"
                aria-label={i18n.t("ui.imagePreview.zoomOut")}
                onClick={() => step(1 / STEP)}
              />
              <Button
                data-slot="image-preview-zoom-level"
                variant="ghost-muted"
                size="small"
                aria-label={i18n.t("ui.imagePreview.zoomToFit")}
                title={i18n.t("ui.imagePreview.zoomToFit")}
                onClick={() => ease(FIT_VIEW)}
              >
                {percent().format(view().scale * fitRatio())}
              </Button>
              <IconButton
                data-slot="image-preview-zoom-in"
                icon={<Icon name="plus" />}
                variant="ghost"
                aria-label={i18n.t("ui.imagePreview.zoomIn")}
                onClick={() => step(STEP)}
              />
            </div>
            <Kobalte.CloseButton
              ref={close}
              data-slot="image-preview-close"
              as={IconButton}
              icon={<Icon name="close" />}
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div
            ref={viewport}
            data-slot="image-preview-body"
            data-zoomed={view().scale > 1 ? "" : undefined}
            data-dragging={drag() ? "" : undefined}
            onDblClick={(event) => {
              if (goal.scale > 1) return ease(FIT_VIEW)
              ease(zoomAt(goal, detailScale(fitRatio()), point(event), bounds()))
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || view().scale <= 1) return
              event.preventDefault()
              viewport.setPointerCapture(event.pointerId)
              setDrag({ id: event.pointerId, x: event.clientX, y: event.clientY })
            }}
            onPointerMove={(event) => {
              const current = drag()

              if (current?.id !== event.pointerId) return
              setDrag({ id: current.id, x: event.clientX, y: event.clientY })
              follow(panBy(view(), { x: event.clientX - current.x, y: event.clientY - current.y }, bounds()))
            }}
            onPointerUp={(event) => {
              if (drag()?.id === event.pointerId) setDrag(undefined)
            }}
            onPointerCancel={(event) => {
              if (drag()?.id === event.pointerId) setDrag(undefined)
            }}
          >
            <img
              ref={image}
              src={props.src}
              alt={props.alt ?? i18n.t("ui.imagePreview.alt")}
              data-slot="image-preview-image"
              draggable={false}
              onLoad={measure}
              style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().scale})` }}
            />
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}

function shortcut(key: string) {
  if (key === "=" || key === "+") return "in"

  if (key === "-" || key === "_") return "out"

  if (key === "0") return "fit"
}

function pixels(event: WheelEvent, delta: number) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * 16

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * window.innerHeight

  return delta
}
