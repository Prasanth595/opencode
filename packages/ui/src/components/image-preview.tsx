import { Dialog as Kobalte, useDialogContext } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { animate, type AnimationPlaybackControls } from "motion"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useDialog, useDialogLayer } from "../context/dialog"
import { useI18n } from "../context/i18n"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { frameLoop, prefersReducedMotion, Spring, type DurationOptions } from "../motion"
import { motionTuning } from "../motion-tuning"
import {
  createFlight,
  elementFrame,
  FLIGHT_SPRING,
  flightStyle,
  intersect,
  KICK,
  type Box,
  type FlightFrame,
} from "./image-flight"
import { clampView, detailScale, FIT_VIEW, maxScale, panBy, wheelZoomFactor, zoomAt, type ZoomView } from "./image-zoom"

export interface ImagePreviewProps {
  src: string
  alt?: string
  /** The image on the page that the preview grows out of and shrinks back into. */
  origin?: HTMLElement
}

const STEP = Math.SQRT2

const group = "Image open"

// One spring carries the open and the close, and the backdrop dims on it too. Snappy is Claude's measured preview.
const tuning = motionTuning.spring("imagePreview", {
  label: "Spring",
  group,
  presets: {
    snappy: FLIGHT_SPRING,
    smooth: { duration: 0.3, bounce: 0 },
    calm: { duration: 0.4, bounce: 0 },
  },
})

// Without a flight (reduced motion, or no thumbnail to fly to), the preview only fades.
const fade = { duration: 0.15, bounce: 0 }

// How long the dialog stays mounted after a close starts, in milliseconds: the flight lands and hands the image back
// to the page well within this.
const exitDuration = () => Math.max(tuning().duration, fade.duration) * 3200

const CENTER = { x: 0, y: 0 }

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  const dialog = useDialogContext()
  let root!: HTMLDivElement
  let scrim!: HTMLDivElement
  let content!: HTMLDivElement
  let viewport!: HTMLDivElement
  let image!: HTMLImageElement
  let standIn!: HTMLImageElement
  let surface!: HTMLDivElement
  let header!: HTMLDivElement
  let edge!: HTMLDivElement
  let close: HTMLButtonElement | undefined
  // Nothing shows until the image has loaded and the preview knows where it lands; while flying, a stand-in image and
  // the panel's surface travel above the dialog in place of the real ones.
  const [stage, setStage] = createSignal<"pending" | "flying" | "rest">("pending")

  // The flight under way: where the stand-in is laid out (the flight only transforms and clips it), the panel at rest
  // and whether its controls sit at its left, the springs, and what happens when it lands.
  let course:
    | { at: Box; panel: Box; rtl: boolean; flight: ReturnType<typeof createFlight>; landed: () => void }
    | undefined

  const dim = Spring.fromDuration(0, FLIGHT_SPRING)
  // Once a close lands, the stand-in fades out over the image the page shows again, so whatever the page draws over
  // its own image (a fade under a sticky bar, say) comes in softly instead of in one frame.
  const veil = Spring.fromDuration(1, FLIGHT_SPRING)

  // How far the flight has become the panel, as last painted: the origin's outline fades out as it rises.
  let lift = 0
  // Without a flight (reduced motion, or nothing on the page to fly to) the panel only fades with the backdrop.
  let plain = false
  let stop: (() => void) | undefined
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

    if (prefersReducedMotion()) return setView(target)
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

  // Kobalte keeps the content mounted while an exit animation runs; the dialog stack waits for the flight too.
  const layer = useDialogLayer()
  const [exit, setExit] = createSignal(0)

  const holdExit = () => {
    setExit(exitDuration())
    layer?.setExitDuration(exit())
  }

  holdExit()

  const reveal = async () => {
    await Promise.all([image.decode(), standIn.decode()]).catch(() => undefined)

    if (stage() !== "pending" || !dialog.isOpen()) return
    const from = prefersReducedMotion() ? undefined : originFrame()
    holdExit()
    dimTo(1, from ? tuning() : fade)

    if (!from) {
      plain = true
      paint()
      setStage("rest")

      return run()
    }

    const flight = createFlight(from)
    const rest = restFrame()
    flight.to(rest, KICK.open, tuning())
    course = { at: place(fitted()), ...panel(rest), flight, landed: () => setStage("rest") }
    hideOrigin()
    paint()
    setStage("flying")
    run()
  }

  const dismiss = () => {
    animation?.stop()

    if (stage() === "pending") return
    const to = prefersReducedMotion() ? undefined : originFrame()
    dimTo(0, to ? tuning() : fade)

    if (!to) {
      plain = true

      return run()
    }

    // A close mid-open turns the flight around where it is, keeping its velocity.
    if (!course) {
      const rest = restFrame()
      course = { at: place(fitted()), ...panel(rest), flight: createFlight(rest), landed: showOrigin }
    }

    course.flight.to(to, KICK.close, tuning())
    course.landed = () => {
      showOrigin()
      veil.omega = (2 * Math.PI) / (tuning().duration * 0.75)
      veil.set(0)
    }

    hideOrigin()
    paint()
    setStage("flying")
    run()
  }

  const dimTo = (target: number, spring: DurationOptions) => {
    dim.omega = (2 * Math.PI) / spring.duration
    dim.zeta = 1 - spring.bounce
    dim.set(target)
  }

  // One job on the shared frame loop steps the flight and the backdrop together and writes them straight to the DOM.
  const run = () => {
    stop ??= frameLoop.add((dt) => {
      const flying = course?.flight.step(dt)
      dim.step(dt)
      veil.step(dt)
      paint()

      // The real image takes over only once the panel holding it is fully opaque, so its brightness doesn't step.
      if (course && !flying && dim.resting) {
        const landed = course.landed
        course = undefined
        landed()
      }

      if (course || !dim.resting || !veil.resting) return true
      stop = undefined

      return false
    })
  }

  const paint = () => {
    scrim.style.opacity = String(dim.value)
    standIn.style.opacity = String(plain ? dim.value : veil.value)
    // Landed, the surface lies under the stand-in's own outline, so it leaves at once rather than fading in between.
    surface.style.opacity = course ? "1" : "0"

    if (course) {
      const frame = course.flight.frame()
      // The controls ride the panel's top corner on their side, fading in as it lifts.
      const side = course.rtl ? frame.surface.x - course.panel.x : right(frame.surface) - right(course.panel)
      header.style.transform = `translate(${side}px, ${frame.surface.y - course.panel.y}px)`
      const style = flightStyle(course.at, frame)
      standIn.style.transform = style.transform
      standIn.style.clipPath = style.clipPath
      // The surface and the outline are leaf boxes, so sizing them every frame stays cheap; scaling them instead would
      // stretch their corners and shadow.
      layout(surface, frame.surface, frame.surfaceRadius)
      surface.style.setProperty("--image-preview-lift", String(frame.lift))
      layout(edge, frame.clip, frame.radius)
      lift = frame.lift
    }

    if (!course) header.style.transform = ""
    // Flying, the panel's controls arrive with the surface; without a flight they fade with the backdrop.
    content.style.opacity = String(plain ? dim.value : course ? lift ** 2 : dim.value ** 2)
    edge.style.opacity = String((1 - lift) * veil.value)
  }

  const place = (box: Box) => {
    Object.assign(standIn.style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    })

    return box
  }

  // The image as shown now, zoomed and panned and cropped to the viewport, in its panel.
  const restFrame = (): FlightFrame => {
    const shown = image.getBoundingClientRect()
    const clip = intersect(shown, viewport.getBoundingClientRect())
    const cropped = clip.width < shown.width - 0.5 || clip.height < shown.height - 0.5

    return {
      image: shown,
      clip,
      radius: cropped ? 0 : parseFloat(getComputedStyle(image).borderTopLeftRadius) * view().scale,
      surface: content.getBoundingClientRect(),
      surfaceRadius: parseFloat(getComputedStyle(content).borderTopLeftRadius) || 0,
      lift: 1,
    }
  }

  const panel = (rest: FlightFrame) => ({ panel: rest.surface, rtl: getComputedStyle(content).direction === "rtl" })

  // The origin's frame, cropped to the part the page shows, or nothing when it is gone or out of sight.
  const originFrame = () => {
    const origin = props.origin

    if (!origin?.isConnected || !image.naturalWidth) return
    const rect = origin.getBoundingClientRect()

    if (!rect.width || !rect.height) return
    // The dialog stack portals the preview with its overlay; both sit over the page it looks through.
    const visible = visibleBox(origin, root.closest("[data-dialog-layer]")?.parentElement ?? root)

    if (!visible) return
    const style = getComputedStyle(origin)
    // An image's outline is often an overlay, since an inset shadow does not paint over an <img>.
    edge.style.boxShadow =
      [style.boxShadow, getComputedStyle(origin, "::after").boxShadow].find((shadow) => shadow !== "none") ?? "none"

    return elementFrame(
      rect,
      { width: image.naturalWidth, height: image.naturalHeight },
      style.objectFit,
      parseFloat(style.borderTopLeftRadius) || 0,
      visible,
    )
  }

  // The image's fitted layout box, wherever zoom has moved it.
  const fitted = (): Box => {
    const shown = image.getBoundingClientRect()

    return {
      x: shown.x + shown.width / 2 - view().x - image.offsetWidth / 2,
      y: shown.y + shown.height / 2 - view().y - image.offsetHeight / 2,
      width: image.offsetWidth,
      height: image.offsetHeight,
    }
  }

  const hideOrigin = () => props.origin?.setAttribute("data-image-preview-origin", "")
  const showOrigin = () => props.origin?.removeAttribute("data-image-preview-origin")

  onCleanup(() => {
    stop?.()
    showOrigin()
  })

  createEffect(
    on(
      () => dialog.isOpen(),
      (open) => {
        if (!open) dismiss()
      },
      { defer: true },
    ),
  )

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
    <div
      ref={root}
      data-component="image-preview"
      data-stage={stage()}
      style={{ "--image-preview-exit": `${exit()}ms` }}
    >
      <div ref={scrim} data-slot="image-preview-scrim" />
      <div data-slot="image-preview-container">
        <Kobalte.Content
          ref={content}
          data-slot="image-preview-content"
          onOpenAutoFocus={(event) => {
            // Open with focus on Close, as before, rather than on the zoom controls that now precede it.
            event.preventDefault()
            close?.focus()
          }}
        >
          <div ref={header} data-slot="image-preview-header">
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
              onLoad={() => {
                measure()
                void reveal()
              }}
              onError={() => void reveal()}
              style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().scale})` }}
            />
          </div>
        </Kobalte.Content>
      </div>
      <div data-slot="image-preview-surface" ref={surface} />
      <img data-slot="image-preview-flight" src={props.src} alt="" aria-hidden="true" ref={standIn} />
      <div data-slot="image-preview-edge" ref={edge} />
    </div>
  )
}

// Dialogs of the mounted surfaces that can show a preview; the Motion workspace's buttons use the newest.
const replayers: ReturnType<typeof useDialog>[] = []

let removeReplay: (() => void) | undefined

/**
 * Adds buttons to the Motion workspace's Image open section while any caller is mounted: they open the newest image in
 * view, or a sample thumbnail when there is none, and close the preview, also mid-flight.
 */
export function replayImagePreview() {
  const dialog = useDialog()
  replayers.push(dialog)
  removeReplay ??= addReplayActions()

  onCleanup(() => {
    replayers.splice(replayers.indexOf(dialog), 1)

    if (replayers.length > 0) return
    removeReplay?.()
    removeReplay = undefined
  })
}

function addReplayActions() {
  const open = () => {
    const image = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-slot="user-message-attachment"][data-type="image"], img[aria-haspopup="dialog"]',
      ),
    ]
      .filter((element) => {
        const rect = element.getBoundingClientRect()

        return rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight
      })
      .at(-1)

    if (image) return image.click()
    const sample = document.createElement("img")
    sample.src = SAMPLE
    sample.alt = "Sample image"
    sample.style.cssText =
      "position: fixed; left: 24px; bottom: 24px; z-index: 40; width: 160px; height: 100px; object-fit: cover; border-radius: 8px;"
    document.body.append(sample)
    replayers.at(-1)?.show(
      () => <ImagePreview src={SAMPLE} alt={sample.alt} origin={sample} />,
      () => setTimeout(() => sample.remove(), exitDuration() + 100),
    )
  }

  const close = () => {
    if (document.querySelector('[data-component="image-preview"]')) replayers.at(-1)?.close()
  }

  const removals = [
    motionTuning.action({ id: "imagePreview.open", label: "Open", group, run: open }),
    motionTuning.action({ id: "imagePreview.close", label: "Close", group, run: close }),
    motionTuning.action({
      id: "imagePreview.reverse",
      label: "Open, close mid-flight",
      group,
      run: () => {
        open()
        const start = performance.now()

        // The flight starts once the image has decoded; close a little way into it.
        const wait = () => {
          if (document.querySelector('[data-component="image-preview"][data-stage="flying"]'))
            return void setTimeout(close, tuning().duration * 350)

          if (performance.now() - start < 2000) requestAnimationFrame(wait)
        }

        requestAnimationFrame(wait)
      },
    }),
  ]

  return () => removals.forEach((remove) => remove())
}

const SAMPLE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs><linearGradient id="sky" x2="0" y2="1"><stop offset="0" stop-color="#ff8a5b"/><stop offset="1" stop-color="#ffd27a"/></linearGradient></defs><rect width="1600" height="1000" fill="url(#sky)"/><circle cx="1120" cy="360" r="170" fill="#fff4d6"/><path d="M0 1000V720Q400 580 800 720T1600 700V1000Z" fill="#2f7d48"/></svg>',
)}`

// The part of `origin` the page under `preview` shows: inside its clipping ancestors and the window, and clear of
// anything drawn over its top or bottom, such as a sticky title bar. Nothing when none of it shows.
function visibleBox(origin: HTMLElement, preview: Element): Box | undefined {
  const clipped = ancestors(origin).reduce(
    (box: Box, element) => {
      const style = getComputedStyle(element)

      if (style.overflowX === "visible" && style.overflowY === "visible") return box

      return intersect(box, element.getBoundingClientRect())
    },
    intersect(origin.getBoundingClientRect(), { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }),
  )

  const rows = Math.floor(clipped.height)

  if (!clipped.width || rows < 1) return
  const x = clipped.x + clipped.width / 2

  // The origin is hidden while the preview flies, so the page shows it where the topmost element under the preview
  // holds it.
  const shows = (y: number) =>
    document
      .elementsFromPoint(x, y)
      .find((element) => !preview.contains(element))
      ?.contains(origin) ?? false

  const top = covered(rows, (row) => shows(clipped.y + row + 0.5))

  if (top === rows) return
  const bottom = covered(rows - top, (row) => shows(clipped.y + clipped.height - row - 0.5))

  return { x: clipped.x, y: clipped.y + top, width: clipped.width, height: clipped.height - top - bottom }
}

function ancestors(element: HTMLElement) {
  const list: HTMLElement[] = []

  for (let parent = element.parentElement; parent; parent = parent.parentElement) list.push(parent)

  return list
}

// How many of `rows`, counted in from an edge, are covered before the first that shows; a covering bar is one piece.
function covered(rows: number, shows: (row: number) => boolean) {
  let low = 0
  let high = rows

  while (low < high) {
    const middle = Math.floor((low + high) / 2)

    if (shows(middle)) {
      high = middle
      continue
    }

    low = middle + 1
  }

  return low
}

function right(box: Box) {
  return box.x + box.width
}

function layout(element: HTMLElement, frame: Box, radius: number) {
  Object.assign(element.style, {
    left: `${frame.x}px`,
    top: `${frame.y}px`,
    width: `${frame.width}px`,
    height: `${frame.height}px`,
    borderRadius: `${radius}px`,
  })
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
