import { Predicate } from "effect"
import { For, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Switch } from "@opencode/ui/switch"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import { showToast } from "@/shell/notifications/toast"
import { useExtensionHost } from "./host"
import { createInstalled } from "./installed"
import { useReservedPlugins } from "./root"

/** Every plugin of this desktop window, built-in or from the app's own server, with enable and reload controls. */
export function PluginsSettings() {
  const language = useLanguage()
  const host = useExtensionHost()
  const bridge = usePlatform().extensions
  const installed = createInstalled(bridge)
  const reserved = useReservedPlugins()

  const itemOf = (id: string) => installed.list().find((item) => item.id === id)

  const enabled = (id: string) => itemOf(id)?.enabled ?? true

  // Why the window entry or main's entry failed; either fails the plugin.
  const errorOf = (id: string) => host.state.failures[id]?.error ?? itemOf(id)?.error

  const status = (id: string) => {
    const value = host.state.status[id] ?? "loading"

    if (value === "failed" || (value === "active" && itemOf(id)?.error))
      return language.t("settings.plugins.status.failed")

    if (value === "active") return language.t("settings.plugins.status.active")

    if (value === "disabled") return language.t("settings.plugins.status.disabled")

    if (value === "blocked") return language.t("settings.plugins.status.blocked")

    return language.t("settings.plugins.status.loading")
  }

  const run = (work: Promise<void> | undefined) =>
    void work?.catch((cause: unknown) =>
      showToast({
        variant: "error",
        title:
          Predicate.hasProperty(cause, "code") && cause.code === "notFound"
            ? language.t("settings.plugins.error.notFound")
            : language.t("common.requestFailed"),
      }),
    )

  const toggle = (id: string, next: boolean) => run(next ? bridge?.manager.enable(id) : bridge?.manager.disable(id))

  // Main entries reload through the manager; the renderer entry reloads here.
  const reload = (id: string) => {
    host.reload(id)
    run(bridge?.manager.reload(id))
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.plugins.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.plugins.description")}</span>
          </div>
        </div>
      </div>
      <div class="settings-tab-body settings-tab-body--sectioned">
        <section class="settings-section" aria-label={language.t("settings.plugins.title")}>
          <SettingsList>
            <For each={host.definitions()}>
              {(definition) => (
                <SettingsRow
                  title={
                    <span class="flex items-center gap-2">
                      <bdi dir="ltr">{definition.id}</bdi>
                      <Show when={itemOf(definition.id)?.builtin}>
                        <span class="text-11-regular text-v2-text-text-muted">
                          {language.t("settings.plugins.builtin")}
                        </span>
                      </Show>
                    </span>
                  }
                  description={
                    <>
                      {status(definition.id)}
                      <Show when={errorOf(definition.id)}>
                        {(error) => <pre class="mt-1 whitespace-pre-wrap text-text-danger-base">{error()}</pre>}
                      </Show>
                    </>
                  }
                >
                  <div class="flex items-center gap-3">
                    <Button size="small" variant="ghost" onClick={() => reload(definition.id)}>
                      {language.t("settings.plugins.reload")}
                    </Button>
                    <Switch hideLabel checked={enabled(definition.id)} onChange={(next) => toggle(definition.id, next)}>
                      {definition.id}
                    </Switch>
                  </div>
                </SettingsRow>
              )}
            </For>
            <For each={reserved()}>
              {(id) => (
                <SettingsRow
                  title={<bdi dir="ltr">{id}</bdi>}
                  description={<span class="text-text-danger-base">{language.t("settings.plugins.reserved")}</span>}
                >
                  {null}
                </SettingsRow>
              )}
            </For>
          </SettingsList>
        </section>
      </div>
    </>
  )
}
