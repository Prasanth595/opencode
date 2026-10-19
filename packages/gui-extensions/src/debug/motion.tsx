import { onCleanup, onMount } from "solid-js"

// The Motion workspace, floating above the debug bar's bottom-right corner. knobs loads only once it opens.
export default function MotionWorkspace(props: { title: string }) {
  let container!: HTMLDivElement
  let unmount: (() => void) | undefined
  let disposed = false

  onCleanup(() => {
    disposed = true
    unmount?.()
  })

  onMount(async () => {
    const { mountMotionPanel } = await import("@opencode/ui/motion-tuning-panel")

    if (!disposed) unmount = mountMotionPanel(container, { title: props.title })
  })

  return (
    <div
      ref={container}
      class="pointer-events-auto fixed bottom-10 right-3 z-50 max-h-[calc(100vh-6rem)] w-[320px] overflow-auto"
    />
  )
}
