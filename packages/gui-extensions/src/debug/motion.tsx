import { onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"

// The Motion workspace and its floating button at the window's bottom-right corner. knobs loads once it opens.
export default function Motion(props: { open: boolean; button: boolean; title: string; toggle: () => void }) {
  return (
    <Portal>
      <Show when={props.button}>
        <button
          type="button"
          aria-pressed={props.open}
          class="fixed bottom-2 right-2 z-50 rounded-full border border-border-weak-base bg-surface-raised-base px-2 py-0.5 font-mono text-[10px] font-black uppercase tracking-[0.04em] text-text-weak opacity-60 hover:opacity-100 aria-pressed:text-text-strong aria-pressed:opacity-100"
          onClick={props.toggle}
        >
          {props.title}
        </button>
      </Show>
      <Show when={props.open}>
        <Workspace title={props.title} />
      </Show>
    </Portal>
  )
}

function Workspace(props: { title: string }) {
  let container!: HTMLDivElement
  let unmount: (() => void) | undefined
  let disposed = false

  onCleanup(() => {
    disposed = true
    unmount?.()
  })

  void import("@opencode/ui/motion-tuning-panel").then(({ mountMotionPanel }) => {
    if (!disposed) unmount = mountMotionPanel(container, { title: props.title })
  })

  return (
    <div
      ref={container}
      class="pointer-events-auto fixed bottom-10 right-3 z-50 max-h-[calc(100vh-6rem)] w-[320px] overflow-auto"
    />
  )
}
