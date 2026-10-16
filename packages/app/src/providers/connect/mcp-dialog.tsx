import { Component, createEffect, createMemo, For, on, Show } from "solid-js"
import { useData } from "@/runtime/server/current"
import { useWorkspaceLocation } from "@/workspaces/location"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useFilteredList } from "@opencode/ui/hooks"
import { Icon } from "@opencode/ui/icon"
import { ScrollView } from "@opencode/ui/scroll-view"
import { Switch } from "@opencode/ui/switch"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import { useMcpToggle } from "@/providers/connect/mcp"
import "@/shell/search-list.css"

const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  disabled: "mcp.status.disabled",
} as const

export const DialogSelectMcp: Component = () => {
  const data = useData()
  const sdk = useWorkspaceLocation()
  const language = useLanguage()
  const toggle = useMcpToggle(() => sdk().directory)

  const servers = createMemo(() => data.location.mcp.server.list({ directory: sdk().directory }) ?? [])

  const items = createMemo(() =>
    servers()
      .map((server) => ({ name: server.name, status: server.status.status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const enabledCount = createMemo(() => items().filter((i) => i.status === "connected").length)

  const select = (name: string) => {
    const status = servers().find((server) => server.name === name)?.status.status

    if (!status || status === "pending" || toggle.isPending) return
    toggle.mutate(name)
  }

  // A toggle changes the server's status, which makes the list reset its highlight; keep the keyboard user's place.
  let kept = ""

  const list = useFilteredList({
    items,
    key: (x) => x.name,
    filterKeys: ["name", "status"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    onSelect: (x) => {
      if (!x) return
      kept = x.name
      select(x.name)
    },
    noInitialSelection: true,
  })

  createEffect(
    on(
      list.flat,
      (items) => {
        if (kept && items.some((item) => item.name === kept)) list.setActive(kept)
      },
      { defer: true },
    ),
  )

  let resultsRef: HTMLDivElement | undefined

  const onKeyDown = (event: KeyboardEvent) => {
    list.onKeyDown(event)
    const active = list.active()

    if (!active) return

    if (kept) kept = active
    resultsRef?.querySelector(`[data-option-key="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest" })
  }

  return (
    <Dialog class="search-list-dialog">
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("dialog.mcp.title")}
          description={language.t("dialog.mcp.description", { enabled: enabledCount(), total: items().length })}
        />
      </DialogHeader>
      <DialogBody class="search-list-body">
        <div class="search-list-search">
          <TextInput
            type="search"
            appearance="base"
            class="!w-full"
            leadingIcon={<Icon name="magnifying-glass" size="small" />}
            value={list.filter()}
            onInput={(event) => {
              kept = ""
              list.onInput(event.currentTarget.value)
            }}
            onKeyDown={onKeyDown}
            placeholder={language.t("common.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            autofocus
            aria-label={language.t("common.search.placeholder")}
            showClearButton={!!list.filter()}
            clearIcon="circle-xmark"
            clearLabel={language.t("common.clear")}
            onClearClick={() => list.clear()}
          />
        </div>
        <ScrollView class="search-list-scroll" viewportRef={(el) => (resultsRef = el)}>
          <Show
            when={list.flat().length > 0}
            fallback={
              <div class="search-list-empty">
                {language.t(items().length > 0 ? "dialog.mcp.search.empty" : "dialog.mcp.empty")}
              </div>
            }
          >
            <div role="listbox" class="search-list-results">
              <For each={list.flat()}>
                {(item) => {
                  const status = () => servers().find((server) => server.name === item.name)?.status

                  const detail = () => {
                    const current = status()

                    if (current?.status === "failed") return current.error

                    if (!current || current.status === "pending") return

                    return language.t(statusLabels[current.status])
                  }

                  return (
                    <div
                      role="option"
                      aria-selected={list.active() === item.name}
                      data-option-key={item.name}
                      data-active={list.active() === item.name ? "" : undefined}
                      class="search-list-row"
                      onMouseMove={() => {
                        kept = ""
                        list.setActive(item.name)
                      }}
                      onMouseLeave={() => list.setActive("")}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => select(item.name)}
                    >
                      <div class="search-list-row-text">
                        <span class="search-list-title">{item.name}</span>
                        <Show when={detail()}>
                          <span class="search-list-detail" title={detail()}>
                            {detail()}
                          </span>
                        </Show>
                      </div>
                      <div class="search-list-trailing" onClick={(event) => event.stopPropagation()}>
                        <Switch
                          checked={status()?.status === "connected"}
                          disabled={
                            status()?.status === "pending" || (toggle.isPending && toggle.variables === item.name)
                          }
                          onChange={() => select(item.name)}
                        />
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </ScrollView>
      </DialogBody>
    </Dialog>
  )
}
