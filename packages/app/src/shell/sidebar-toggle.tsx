import { Show } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useSettings } from "@/settings/model"

// Native controls: 14px left inset, two 20px button pitches, and a 14px button.
export const macTrafficLightsBaseWidth = 68

// The toggle's 28px plus a 4px gap before the header contents.
const slotWidth = 32

// The shell's 8px inline inset plus the session header's 10px start padding.
const contentStart = 18

export function SidebarToggle() {
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const keybind = () => command.keybindParts("sidebar.toggle")

  return (
    <Tooltip
      class="shrink-0 [app-region:no-drag]"
      placement="bottom"
      value={
        <>
          {language.t("command.sidebar.toggle")}
          <Show when={keybind().length > 0}>
            <Keybind keys={keybind()} variant="neutral" />
          </Show>
        </>
      }
    >
      <IconButton
        type="button"
        variant="ghost-muted"
        size="large"
        class="shrink-0"
        state={settings.appearance.sidebarOpen() ? "pressed" : undefined}
        onClick={() => settings.appearance.setSidebarOpen(!settings.appearance.sidebarOpen())}
        aria-label={language.t("command.sidebar.toggle")}
        aria-expanded={settings.appearance.sidebarOpen()}
        aria-controls="vertical-tabs-sidebar"
        icon={<Icon name="layout-left" />}
      />
    </Tooltip>
  )
}

// Where the collapsed sidebar's toggle sits at the start of the content area. Windows keeps its titlebar in vertical
// tabs mode, so the toggle lives there instead.
function useCollapsedSlot() {
  const platform = usePlatform()
  const settings = useSettings()
  const desktop = createMediaQuery("(min-width: 768px)")
  const windows = () => platform.platform === "desktop" && platform.os === "windows"
  const mac = () => platform.platform === "desktop" && platform.os === "macos" && !platform.windowFullscreen?.()

  return {
    visible: () => desktop() && !windows() && settings.appearance.tabLayout() === "vertical",
    open: settings.appearance.sidebarOpen,
    // Keep the toggle clear of the traffic lights, which end 68px from the window edge.
    width: () =>
      mac() ? macTrafficLightsBaseWidth / (platform.webviewZoom?.() ?? 1) - contentStart + slotWidth : slotWidth,
  }
}

const slotClass =
  "flex shrink-0 justify-end overflow-hidden transition-[width] duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none"

// Floats over the top of every screen, centered on the session header's 48px row. Slides in from the content's start
// edge as the sidebar closes.
export function CollapsedSidebarToggle() {
  const slot = useCollapsedSlot()

  return (
    <Show when={slot.visible()}>
      <div
        class={`absolute top-[calc(var(--shell-top-inset,8px)+10px)] start-[calc(var(--shell-inline-inset,8px)+10px)] z-40 ${slotClass}`}
        style={{ width: slot.open() ? "0px" : `${slot.width()}px` }}
        inert={slot.open()}
      >
        <div class="flex shrink-0 pe-1">
          <SidebarToggle />
        </div>
      </div>
    </Show>
  )
}

// Reserves the floating toggle's room in a header, pushing its contents along as the toggle slides in. `start` is where
// the space begins, in pixels from the content area's start edge, so every header's contents line up after the toggle.
export function CollapsedSidebarToggleSpace(props: { start?: number; class?: string }) {
  const slot = useCollapsedSlot()

  return (
    <Show when={slot.visible()}>
      <div
        aria-hidden="true"
        class={`${slotClass} ${props.class ?? ""}`}
        style={{ width: slot.open() ? "0px" : `${slot.width() + contentStart - (props.start ?? contentStart)}px` }}
      />
    </Show>
  )
}
