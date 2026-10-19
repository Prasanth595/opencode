import { createSignal, Show } from "solid-js"
import { NewSessionPinBoard } from "./pin-board"
import { NewSessionWordmark } from "./wordmark"

export default {
  title: "App/New Session/Wordmark",
  id: "app-new-session-wordmark",
  component: NewSessionWordmark,
}

export const PinBoard = {
  render: () => {
    const [logo, setLogo] = createSignal<HTMLDivElement>()

    return (
      <div
        data-component="new-session"
        class="relative isolate h-[640px] w-full overflow-hidden rounded-[10px] bg-v2-background-bg-base"
      >
        <div class="absolute inset-x-0 top-[25%] flex justify-center px-6">
          <div class="w-full max-w-[720px]">
            <NewSessionWordmark ref={setLogo} />
            <form
              data-component="composer"
              class="mt-8 h-24 w-full rounded-xl bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
            />
          </div>
        </div>
        <Show when={logo()}>{(element) => <NewSessionPinBoard logo={element()} sound={() => true} />}</Show>
      </div>
    )
  },
}
