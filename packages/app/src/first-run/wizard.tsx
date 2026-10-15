import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { For, Match, Switch, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { ConnectStep } from "./connect-step"

const TOTAL_STEPS = 3

/**
 * Full-screen first-run wizard for people who have never used an AI tool.
 * Every word is plain and jargon-free; every step shows progress, can go
 * back, and can be skipped or closed without breaking the app.
 */
export const FirstRunWizard: Component<{ onDone: () => void }> = (props) => {
  const language = useLanguage()
  const [state, setState] = createStore({ step: 1 })

  const close = () => props.onDone()

  return (
    <div
      class="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-v2-background-bg-base p-4"
      role="dialog"
      aria-modal="true"
      aria-label={language.t("firstRun.dialog.label")}
      onKeyDown={(event) => {
        if (event.key === "Escape") close()
      }}
    >
      <div class="w-full max-w-[460px] rounded-2xl border border-v2-border-border-base bg-v2-background-bg-layer-01 p-6 shadow-2xl sm:p-8">
        <div class="mb-5 flex items-center justify-between">
          <div class="flex items-center gap-1.5" aria-hidden="true">
            <For each={[1, 2, 3]}>
              {(n) => (
                <span
                  class="h-1.5 rounded-full transition-all"
                  classList={{
                    "w-6 bg-v2-text-text-base": n <= state.step,
                    "w-1.5 bg-v2-border-border-base": n > state.step,
                  }}
                />
              )}
            </For>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label={language.t("firstRun.close")}
            class="flex size-8 items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
          >
            <Icon name="close" size="small" />
          </button>
        </div>

        <p class="mb-4 text-[13px] font-medium text-v2-text-text-muted">
          {language.t("firstRun.progress", { current: state.step, total: TOTAL_STEPS })}
        </p>

        <Switch>
          <Match when={state.step === 1}>
            <div class="flex flex-col items-center text-center">
              <div class="mb-5 flex size-14 items-center justify-center rounded-2xl bg-v2-background-bg-layer-03">
                <Icon name="bubble-5" size="large" class="text-v2-text-text-base" />
              </div>
              <h1 class="text-[20px] font-semibold tracking-[-0.2px] text-v2-text-text-base">
                {language.t("firstRun.step1.title")}
              </h1>
              <p class="mt-2 text-[14px] leading-6 text-v2-text-text-muted">
                {language.t("firstRun.step1.body")}
              </p>
              <Button class="mt-6 w-full" size="large" variant="contrast" onClick={() => setState("step", 2)}>
                {language.t("firstRun.continue")}
              </Button>
              <button
                type="button"
                onClick={close}
                class="mt-3 text-[13px] text-v2-text-text-muted underline-offset-4 hover:underline"
              >
                {language.t("firstRun.skip")}
              </button>
            </div>
          </Match>

          <Match when={state.step === 2}>
            <ConnectStep onConnected={() => setState("step", 3)} onBack={() => setState("step", 1)} onSkip={close} />
          </Match>

          <Match when={state.step === 3}>
            <div class="flex flex-col items-center text-center">
              <div class="mb-5 flex size-14 items-center justify-center rounded-full bg-v2-background-bg-layer-03">
                <Icon name="circle-check" size="large" class="text-v2-state-fg-success" />
              </div>
              <h1 class="text-[20px] font-semibold tracking-[-0.2px] text-v2-text-text-base">
                {language.t("firstRun.step3.title")}
              </h1>
              <p class="mt-2 text-[14px] leading-6 text-v2-text-text-muted">
                {language.t("firstRun.step3.body")}
              </p>
              <Button class="mt-6 w-full" size="large" variant="contrast" onClick={close}>
                {language.t("firstRun.step3.start")}
              </Button>
              <button
                type="button"
                onClick={() => setState("step", 2)}
                class="mt-3 flex items-center gap-1.5 text-[13px] font-medium text-v2-text-text-muted hover:text-v2-text-text-base"
              >
                <Icon name="arrow-left" size="small" />
                {language.t("firstRun.back")}
              </button>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
