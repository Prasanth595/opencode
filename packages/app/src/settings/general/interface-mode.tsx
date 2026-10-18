import { For, createUniqueId } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { type TabLayout, useSettings } from "@/settings/model"
import "./interface-mode.css"

const modes = [
  { id: "focus", layout: "horizontal" },
  { id: "pro", layout: "vertical" },
] as const satisfies { id: string; layout: TabLayout }[]

export function InterfaceModeSetting() {
  const language = useLanguage()
  const settings = useSettings()
  const id = createUniqueId()

  return (
    <fieldset data-component="interface-mode" data-action="settings-tab-layout">
      <legend class="sr-only">{language.t("settings.general.row.interfaceMode.title")}</legend>
      <For each={modes}>
        {(mode) => (
          <label
            data-slot="interface-mode-option"
            data-checked={settings.appearance.tabLayout() === mode.layout ? "" : undefined}
          >
            <input
              type="radio"
              name={id}
              value={mode.id}
              checked={settings.appearance.tabLayout() === mode.layout}
              aria-labelledby={`${id}-${mode.id}-title`}
              aria-describedby={`${id}-${mode.id}`}
              onChange={() => settings.appearance.setTabLayout(mode.layout)}
            />
            <div data-slot="interface-mode-preview" data-mode={mode.id} aria-hidden="true">
              {mode.id === "focus" ? <FocusPreview /> : <ProPreview />}
            </div>
            <div data-slot="interface-mode-copy">
              <span id={`${id}-${mode.id}-title`} data-slot="interface-mode-title">
                <span data-slot="interface-mode-radio" />
                {language.t(`settings.general.row.interfaceMode.${mode.id}`)}
              </span>
              <span id={`${id}-${mode.id}`} data-slot="interface-mode-description">
                {language.t(`settings.general.row.interfaceMode.${mode.id}.description`)}
              </span>
            </div>
          </label>
        )}
      </For>
    </fieldset>
  )
}

function FocusPreview() {
  return (
    <>
      <div data-slot="preview-tabs">
        <span data-active />
        <span />
        <span />
      </div>
      <div data-slot="preview-chat">
        <span data-slot="preview-bubble" />
        <span data-slot="preview-line" style={{ width: "86%" }} />
        <span data-slot="preview-line" style={{ width: "72%" }} />
        <span data-slot="preview-line" style={{ width: "48%" }} />
        <span data-slot="preview-bubble" style={{ width: "34%" }} />
        <span data-slot="preview-line" style={{ width: "64%" }} />
        <span data-slot="preview-composer" />
      </div>
    </>
  )
}

function ProPreview() {
  return (
    <>
      <div data-slot="preview-rail">
        <For each={[70, 52, 64, 44, 58, 36]}>
          {(width, index) => (
            <span data-slot="preview-rail-tab" data-active={index() === 1 ? "" : undefined}>
              <i />
              <span style={{ width: `${width}%` }} />
            </span>
          )}
        </For>
      </div>
      <div data-slot="preview-main">
        <div data-slot="preview-toolbar">
          <i />
          <i />
          <i />
          <i />
        </div>
        <For each={[92, 78, 84, 60, 88, 70, 40]}>
          {(width) => <span data-slot="preview-line" style={{ width: `${width}%` }} />}
        </For>
        <span data-slot="preview-composer">
          <i />
          <i />
        </span>
      </div>
      <div data-slot="preview-panel">
        <For each={[80, 64, 72, 50, 68]}>
          {(width) => <span data-slot="preview-line" style={{ width: `${width}%` }} />}
        </For>
      </div>
    </>
  )
}
