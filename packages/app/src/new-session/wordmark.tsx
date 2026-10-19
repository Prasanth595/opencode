/** Reserves the wordmark's space. `NewSessionPinBoard` draws the logo into it. */
export function NewSessionWordmark(props: { ref: (element: HTMLDivElement) => void }) {
  return (
    <div
      data-component="new-session-wordmark"
      aria-hidden="true"
      class="pointer-events-none mx-auto w-full max-w-[720px]"
    >
      <div ref={props.ref} data-slot="wordmark-box" class="mx-auto aspect-[234/42] w-4/5" />
    </div>
  )
}
