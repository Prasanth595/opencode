import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Spinner } from "@opencode/ui/spinner"
import { TextInput } from "@opencode/ui/text-input"
import { createEffect, createMemo, createUniqueId, For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useIntegrations } from "@/providers/catalog/integrations"
import { createProviderConnectionController } from "@/providers/connect/controller"

// Minimal shape of the desktop bridge for key validation. Undefined on web,
// where validation is skipped (upstream behavior).
type ElectronBridge = {
  validateProviderKey(
    providerID: string,
    key: string,
  ): Promise<{ valid: boolean; reason?: "invalid_key" | "unreachable" | "unsupported" }>
}

const getBridge = (): ElectronBridge | undefined =>
  typeof window !== "undefined"
    ? (window as unknown as { electron?: ElectronBridge }).electron
    : undefined

// Friendly providers that accept a pasted API key, in presentation order,
// each with a direct link to its key settings page.
const CURATED = [
  { id: "anthropic", helpUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", helpUrl: "https://platform.openai.com/api-keys" },
  { id: "google", helpUrl: "https://aistudio.google.com/apikey" },
]

type ProviderOption = {
  id: string
  name: string
  helpUrl?: string
}

/**
 * Step 2 of the first-run wizard: pick a provider and paste an API key.
 * Reuses the shared provider connection controller (the same machinery as
 * the full connect dialog) but presents a single key field with plain-word
 * guidance. Failures surface as kind messages, never raw errors.
 */
export const ConnectStep: Component<{
  onConnected: () => void
  onBack: () => void
  onSkip: () => void
}> = (props) => {
  const language = useLanguage()
  const integrations = useIntegrations(() => undefined)
  const errorID = createUniqueId()

  const options = createMemo<ProviderOption[]>(() => {
    const list = integrations.list()

    const curated = CURATED.flatMap((entry) => {
      const found = list.find((item) => item.id === entry.id)

      return found ? [{ id: found.id, name: found.name, helpUrl: entry.helpUrl }] : []
    })

    if (curated.length > 0) return curated

    return list.slice(0, 3).map((item) => ({ id: item.id, name: item.name }))
  })

  const [state, setState] = createStore<{
    provider: string
    key: string
    helpOpen: boolean
    busy: boolean
    error?: string
  }>({
    provider: "",
    key: "",
    helpOpen: false,
    busy: false,
  })

  let advanced = false

  const advance = () => {
    if (advanced) return
    advanced = true
    props.onConnected()
  }

  const controller = createProviderConnectionController({
    provider: () => state.provider,
    directory: () => undefined,
    // The wizard drives the key method itself instead of auto-selecting.
    manual: () => true,
    onComplete: advance,
  })

  // Default to the first curated provider once the catalog loads.
  createEffect(() => {
    if (state.provider) return
    const first = options()[0]

    if (first) setState("provider", first.id)
  })

  // Always land on the API-key method; some providers offer several ways in.
  createEffect(() => {
    if (!state.provider || controller.loading() || controller.methodIndex() !== undefined) return
    const index = controller.methods().findIndex((method) => method.type === "key")

    if (index === -1) {
      setState("error", language.t("firstRun.step2.error.noKeyMethod"))

      return
    }

    void controller.auth.select(index)
  })

  const selectProvider = (id: string) => {
    if (id === state.provider) return
    controller.auth.reset()
    setState({ provider: id, error: undefined })
  }

  const helpUrl = () => options().find((item) => item.id === state.provider)?.helpUrl

  const connect = async () => {
    const key = state.key.trim()

    if (!key) {
      setState("error", language.t("firstRun.step2.error.empty"))

      return
    }

    setState({ busy: true, error: undefined })

    // Validate the key with the provider before storing it, so a typo'd key
    // is caught here with a kind message instead of failing at the first chat.
    // Only a definitive rejection blocks; anything inconclusive falls through
    // to storing (upstream behavior). Skipped entirely on web (no bridge).
    const bridge = getBridge()
    if (bridge) {
      try {
        const verdict = await bridge.validateProviderKey(state.provider, key)

        if (!verdict.valid && verdict.reason === "invalid_key") {
          setState({ busy: false, error: language.t("firstRun.step2.error.invalidKey") })

          return
        }
      } catch {
        // The probe itself failed; don't punish the user for it, proceed to store.
      }
    }

    try {
      await controller.auth.connectKey(key)
    } catch {
      // The key is stored, not validated, server-side; anything thrown here
      // is a transport or server failure. Stay kind and never dump it.
      setState({ busy: false, error: language.t("firstRun.step2.error.failed") })

      return
    }

    // onComplete fires from the controller, but advance() guards the double call
    // in case the catalog refresh stalls silently.
    advance()
  }

  const providerName = () => options().find((item) => item.id === state.provider)?.name ?? state.provider

  return (
    <div class="flex flex-col">
      <h1 class="text-[20px] font-semibold tracking-[-0.2px] text-v2-text-text-base">
        {language.t("firstRun.step2.title")}
      </h1>
      <p class="mt-2 text-[14px] leading-6 text-v2-text-text-muted">{language.t("firstRun.step2.body")}</p>

      <div class="mt-5 text-[13px] font-medium text-v2-text-text-base">
        {language.t("firstRun.step2.providerLabel")}
      </div>
      <div class="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={language.t("firstRun.step2.providerLabel")}>
        <For each={options()}>
          {(option) => (
            <button
              type="button"
              role="radio"
              aria-checked={state.provider === option.id}
              onClick={() => selectProvider(option.id)}
              class="rounded-full border px-4 py-2 text-[13px] font-medium transition-colors"
              classList={{
                "border-v2-text-text-base bg-v2-text-text-base text-v2-background-bg-base":
                  state.provider === option.id,
                "border-v2-border-border-base text-v2-text-text-muted hover:text-v2-text-text-base":
                  state.provider !== option.id,
              }}
            >
              {option.name}
            </button>
          )}
        </For>
      </div>

      <form
        class="mt-5 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void connect()
        }}
      >
        <label class="flex flex-col gap-2 text-[13px] font-medium text-v2-text-text-base">
          {language.t("firstRun.step2.keyLabel")}
          <TextInput
            ref={(input: HTMLInputElement) => queueMicrotask(() => input.focus())}
            type="password"
            name="apiKey"
            class="!w-full"
            placeholder={language.t("firstRun.step2.keyPlaceholder")}
            value={state.key}
            invalid={state.error !== undefined}
            aria-describedby={state.error ? errorID : undefined}
            autocomplete="off"
            spellcheck={false}
            onInput={(event) => setState({ key: event.currentTarget.value, error: undefined })}
          />
        </label>

        <Show when={state.error}>
          {(error) => (
            <div id={errorID} role="alert" class="flex items-start gap-2 text-[13px] text-v2-state-fg-danger">
              <Icon name="circle-exclamation" size="small" class="mt-0.5 shrink-0" />
              <span>{error()}</span>
            </div>
          )}
        </Show>

        <div>
          <button
            type="button"
            onClick={() => setState("helpOpen", !state.helpOpen)}
            aria-expanded={state.helpOpen}
            class="flex items-center gap-1.5 text-[13px] font-medium text-v2-text-text-muted underline-offset-4 hover:underline"
          >
            <Icon name="help" size="small" />
            {language.t("firstRun.step2.keyHelpTitle")}
          </button>
          <Show when={state.helpOpen}>
            <div class="mt-2 rounded-lg bg-v2-background-bg-layer-03 p-3 text-[13px] leading-5 text-v2-text-text-muted">
              <p>{language.t("firstRun.step2.keyHelpBody")}</p>
              <Show when={helpUrl()}>
                {(url) => (
                  <a
                    href={url()}
                    target="_blank"
                    rel="noreferrer"
                    class="mt-1.5 inline-block font-medium text-v2-text-text-base underline-offset-4 hover:underline"
                  >
                    {language.t("firstRun.step2.keyHelpLink", { provider: providerName() })}
                  </a>
                )}
              </Show>
            </div>
          </Show>
        </div>

        <Button
          type="submit"
          variant="contrast"
          size="large"
          class="mt-1 w-full"
          disabled={state.busy || !state.provider}
          aria-busy={state.busy}
        >
          <Show when={state.busy} fallback={language.t("firstRun.step2.connect")}>
            <span class="flex items-center justify-center gap-2">
              <Spinner class="size-4" />
              {language.t("firstRun.step2.connecting")}
            </span>
          </Show>
        </Button>
      </form>

      <div class="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={props.onBack}
          class="flex items-center gap-1.5 text-[13px] font-medium text-v2-text-text-muted hover:text-v2-text-text-base"
        >
          <Icon name="arrow-left" size="small" />
          {language.t("firstRun.back")}
        </button>
        <button
          type="button"
          onClick={props.onSkip}
          class="text-[13px] text-v2-text-text-muted underline-offset-4 hover:underline"
        >
          {language.t("firstRun.skip")}
        </button>
      </div>
    </div>
  )
}
