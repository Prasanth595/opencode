import { createEffect, createMemo, createResource, createSignal, on, Show, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { SnapshotFileDiff, VcsChangeStatus, VcsFileDiff, VcsRemoteStatus } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import {
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX,
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN,
  SessionReviewV2,
  SessionReviewV2Sidebar,
} from "@opencode-ai/session-ui/v2/session-review-v2"
import { SessionReviewFilePreviewV2 } from "@opencode-ai/session-ui/v2/session-review-file-preview-v2"
import { DiffChanges } from "@opencode-ai/ui/v2/diff-changes-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { SplitButtonV2, SplitButtonV2Action, SplitButtonV2MenuTrigger } from "@opencode-ai/ui/v2/split-button-v2"
import { DialogV2, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type {
  SessionReviewComment,
  SessionReviewCommentActions,
  SessionReviewCommentDelete,
  SessionReviewCommentUpdate,
  SessionReviewDiffStyle,
  SessionReviewFocus,
  SessionReviewLineComment,
} from "@opencode-ai/session-ui/session-review"
import FileTreeV2 from "@/components/file-tree-v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import {
  filterRenderableDiff,
  filterReviewFiles,
  reviewDiffKinds,
  reviewDiffNeedsLoad,
  type RenderDiff,
} from "@/pages/session/v2/review-diff-kinds"
import type { ReviewPanelV2State } from "@/pages/session/v2/review-panel-v2-state"
import { applyFileListKeyDown, SessionFileListV2 } from "@/pages/session/v2/session-file-list-v2"

type ReviewDiff = FileDiffInfo | SnapshotFileDiff | VcsFileDiff

export type ReviewPanelV2Props = {
  title?: JSX.Element
  empty?: JSX.Element
  diffs: () => ReviewDiff[]
  diffsReady: () => boolean
  diffVersion?: number
  loadDiff?: (path: string, version?: number) => Promise<RenderDiff | undefined>
  activeFile?: string
  onSelectFile: (path: string) => void
  diffStyle: SessionReviewDiffStyle
  onDiffStyleChange?: (style: SessionReviewDiffStyle) => void
  state: ReviewPanelV2State
  gitChangesEnabled?: boolean
  branch?: string
  sessionID?: () => string | undefined
  activeModel?: () => { providerID: string; modelID: string; variant?: string | null } | undefined
  onGitChange?: () => void
  onLineComment?: (comment: SessionReviewLineComment) => void
  onLineCommentUpdate?: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete?: (comment: SessionReviewCommentDelete) => void
  lineCommentActions?: SessionReviewCommentActions
  comments?: SessionReviewComment[]
  focusedComment?: SessionReviewFocus | null
  onFocusedCommentChange?: (focus: SessionReviewFocus | null) => void
}

export function ReviewPanelV2(props: ReviewPanelV2Props) {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const [git, setGit] = createStore({
    message: "",
    busy: false,
    error: "",
    loadError: "",
    changes: [] as VcsChangeStatus[],
    remote: { upstream: false, ahead: 0, behind: 0 } as VcsRemoteStatus,
  })
  createEffect(
    on(
      [() => sdk().directory, () => props.sessionID?.()],
      () =>
        setGit({
          message: "",
          error: "",
          loadError: "",
          changes: [],
          remote: { upstream: false, ahead: 0, behind: 0 },
        }),
      { defer: true },
    ),
  )
  // A plain store instead of createResource: the side panel sits inside a fallback-less
  // Suspense, so reading a refetching resource blanked the whole file list after every action.
  const loadChanges = () => {
    const directory = sdk().directory
    return Promise.all([
      sdk().client.instance.vcsChanges({ directory }, { throwOnError: true }),
      sdk().client.instance.vcsRemote({ directory }, { throwOnError: true }),
    ])
      .then(([changes, remote]) => {
        if (sdk().directory !== directory) return
        setGit("changes", reconcile(changes.data ?? [], { key: "file" }))
        if (remote.data) setGit("remote", remote.data)
        setGit("loadError", "")
      })
      .catch((error) => setGit("loadError", error instanceof Error ? error.message : String(error)))
  }
  createEffect(
    on(
      () => (props.gitChangesEnabled ? ([sdk().directory, props.diffVersion] as const) : undefined),
      (source) => {
        if (source) void loadChanges()
      },
    ),
  )
  const runGit = async (run: () => Promise<unknown>, input?: { optimistic?: () => void; refresh?: boolean }) => {
    if (git.busy) return false
    setGit({ busy: true, error: "" })
    input?.optimistic?.()
    const success = await run().then(
      () => true,
      (error) => {
        setGit("error", error instanceof Error ? error.message : String(error))
        return false
      },
    )
    // Reload even on failure so an optimistic update snaps back to the real index state.
    if (input?.refresh !== false) {
      props.onGitChange?.()
      await loadChanges()
    }
    setGit("busy", false)
    return success
  }
  const setStaged = (staged: boolean, file?: string) =>
    setGit("changes", (change) => file === undefined || change.file === file, { staged, unstaged: !staged })
  const changesByFile = createMemo(() => new Map(git.changes.map((change) => [change.file, change] as const)))
  const stagedCount = () => git.changes.filter((change) => change.staged).length
  const allStaged = () => git.changes.length > 0 && git.changes.every((change) => change.staged && !change.unstaged)
  const fileAccessory = (path: string) => (
    <Show when={changesByFile().get(path)}>
      {(change) => (
        <>
          <IconButtonV2
            size="small"
            variant="ghost-muted"
            icon={<Icon name="outline-reset" />}
            class="opacity-0 group-hover/git-row:opacity-100 group-focus-within/git-row:opacity-100"
            classList={{ invisible: !change().unstaged }}
            title={language.t("session.review.git.discard")}
            aria-label={language.t("session.review.git.discardFile", { file: path })}
            onClick={() => dialog.show(() => <DiscardDialog file={path} />)}
          />
          <CheckboxV2
            label={language.t(
              change().staged && !change().unstaged ? "session.review.git.unstageFile" : "session.review.git.stageFile",
              { file: path },
            )}
            hideLabel
            checked={change().staged && !change().unstaged}
            indeterminate={change().staged && change().unstaged}
            onChange={() => {
              // Partially staged files stage their remaining changes, matching the tri-state checkbox.
              const stage = !change().staged || change().unstaged
              void runGit(
                () =>
                  stage
                    ? sdk().client.instance.vcsStage({ directory: sdk().directory, file: path }, { throwOnError: true })
                    : sdk().client.instance.vcsUnstage(
                        { directory: sdk().directory, file: path },
                        { throwOnError: true },
                      ),
                { optimistic: () => setStaged(stage, path) },
              )
            }}
          />
        </>
      )}
    </Show>
  )

  function DiscardDialog(input: { file: string }) {
    return (
      <DialogV2 fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("session.review.git.discard")}
            description={language.t("session.review.git.discard.confirm", { file: input.file })}
          />
        </DialogHeader>
        <Show when={git.error}>
          <div role="alert" class="px-4 text-12-regular text-text-danger">
            {git.error}
          </div>
        </Show>
        <DialogFooter>
          <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            variant="danger"
            disabled={git.busy}
            onClick={async () => {
              const success = await runGit(() =>
                sdk().client.instance.vcsDiscard(
                  { directory: sdk().directory, file: input.file },
                  { throwOnError: true },
                ),
              )
              if (success) dialog.close()
            }}
          >
            {language.t("session.review.git.discard")}
          </ButtonV2>
        </DialogFooter>
      </DialogV2>
    )
  }

  const stageAll = () => sdk().client.instance.vcsStageAll({ directory: sdk().directory }, { throwOnError: true })
  const unstageAll = () => sdk().client.instance.vcsUnstageAll({ directory: sdk().directory }, { throwOnError: true })
  const commit = () =>
    sdk()
      .client.instance.vcsCommit({ directory: sdk().directory, message: git.message }, { throwOnError: true })
      .then(() => setGit("message", ""))
  // Nothing left to commit but local commits exist: the remote button's primary action becomes Push.
  const pushReady = () => git.changes.length === 0 && git.remote.ahead > 0
  const remote = {
    fetch: () => sdk().client.instance.vcsFetch({ directory: sdk().directory }, { throwOnError: true }),
    pull: () => sdk().client.instance.vcsPull({ directory: sdk().directory }, { throwOnError: true }),
    push: () => sdk().client.instance.vcsPush({ directory: sdk().directory }, { throwOnError: true }),
  }

  // Sits directly above the file list, aligned with the per-file checkboxes.
  const gitControls = () => (
    <Show when={props.gitChangesEnabled && git.changes.length > 0}>
      <div class="flex h-8 items-center gap-2 px-4">
        <span class="min-w-0 flex-1 truncate text-12-regular text-text-weak">
          {language.t("session.review.git.stagedOf", { staged: stagedCount(), total: git.changes.length })}
        </span>
        <SplitButtonV2 data-variant="outline">
          <SplitButtonV2Action
            disabled={git.busy}
            onClick={() => {
              const stage = !allStaged()
              void runGit(stage ? stageAll : unstageAll, { optimistic: () => setStaged(stage) })
            }}
          >
            {language.t(allStaged() ? "session.review.git.unstageAll" : "session.review.git.stageAll")}
          </SplitButtonV2Action>
          <MenuV2 gutter={4} modal={false} placement="bottom-end">
            <MenuV2.Trigger
              as={SplitButtonV2MenuTrigger}
              disabled={git.busy}
              aria-label={language.t("session.review.git.stagingMenu")}
            >
              <Icon name="chevron-down" size="small" />
            </MenuV2.Trigger>
            <MenuV2.Portal>
              <MenuV2.Content>
                <MenuV2.Item
                  disabled={allStaged()}
                  onSelect={() => void runGit(stageAll, { optimistic: () => setStaged(true) })}
                >
                  {language.t("session.review.git.stageAll")}
                </MenuV2.Item>
                <MenuV2.Item
                  disabled={stagedCount() === 0}
                  onSelect={() => void runGit(unstageAll, { optimistic: () => setStaged(false) })}
                >
                  {language.t("session.review.git.unstageAll")}
                </MenuV2.Item>
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
        </SplitButtonV2>
      </div>
    </Show>
  )

  const gitFooter = () => (
    <Show when={props.gitChangesEnabled}>
      <div class="flex shrink-0 flex-col gap-2 border-t border-border-weak-base p-2">
        <div class="flex items-center justify-between gap-2 ps-1">
          <span class="flex min-w-0 items-center gap-1.5 text-12-medium text-text-base">
            <Icon name="branch" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            <bdi dir="ltr" class="min-w-0 truncate">
              {props.branch}
            </bdi>
          </span>
          <SplitButtonV2 data-variant="outline">
            <SplitButtonV2Action
              disabled={git.busy}
              onClick={() => void runGit(pushReady() ? remote.push : remote.fetch)}
            >
              <Show
                when={pushReady()}
                fallback={
                  <>
                    <Icon name="sync" size="small" />
                    {language.t("session.review.git.fetch")}
                  </>
                }
              >
                <Icon name="arrow-up" size="small" />
                {language.t("session.review.git.push")}
                <span class="tabular-nums text-v2-text-text-muted">{git.remote.ahead}</span>
              </Show>
            </SplitButtonV2Action>
            <MenuV2 gutter={4} modal={false} placement="bottom-end">
              <MenuV2.Trigger
                as={SplitButtonV2MenuTrigger}
                disabled={git.busy}
                aria-label={language.t("session.review.git.remoteMenu")}
              >
                <Icon name="chevron-down" size="small" />
              </MenuV2.Trigger>
              <MenuV2.Portal>
                <MenuV2.Content>
                  <MenuV2.Item onSelect={() => void runGit(remote.fetch)}>
                    {language.t("session.review.git.fetch")}
                  </MenuV2.Item>
                  <MenuV2.Item onSelect={() => void runGit(remote.pull)}>
                    {language.t("session.review.git.pull")}
                  </MenuV2.Item>
                  <MenuV2.Separator />
                  <MenuV2.Item
                    badge={git.remote.ahead > 0 ? `↑${git.remote.ahead}` : undefined}
                    onSelect={() => void runGit(remote.push)}
                  >
                    {language.t("session.review.git.push")}
                  </MenuV2.Item>
                </MenuV2.Content>
              </MenuV2.Portal>
            </MenuV2>
          </SplitButtonV2>
        </div>
        <div class="flex h-36 shrink-0 flex-col overflow-hidden rounded-lg border border-v2-border-border-muted bg-v2-background-bg-base transition-colors focus-within:border-v2-border-border-focus">
          <textarea
            class="min-h-0 flex-1 resize-none bg-transparent px-2.5 py-2 text-12-regular text-text-base outline-none placeholder:text-v2-text-text-faint"
            aria-label={language.t("session.review.git.message.placeholder")}
            placeholder={language.t("session.review.git.message.placeholder")}
            value={git.message}
            onInput={(event) => setGit("message", event.currentTarget.value)}
          />
          <div class="flex shrink-0 items-center justify-between gap-2 px-1.5 pb-1.5">
            <IconButtonV2
              size="small"
              variant="ghost-muted"
              icon={<Icon name="sparkle" />}
              title={language.t("session.review.git.generate")}
              aria-label={language.t("session.review.git.generate")}
              disabled={git.busy || git.changes.length === 0 || !props.sessionID?.()}
              onClick={() =>
                void runGit(
                  async () => {
                    const active = props.activeModel?.()
                    const response = await sdk().client.instance.vcsGenerateMessage(
                      {
                        directory: sdk().directory,
                        sessionID: props.sessionID?.() ?? "",
                        ...(active
                          ? {
                              model: {
                                providerID: active.providerID,
                                modelID: active.modelID,
                                ...(active.variant ? { variant: active.variant } : {}),
                              },
                            }
                          : {}),
                      },
                      { throwOnError: true },
                    )
                    setGit("message", response.data?.message ?? "")
                  },
                  { refresh: false },
                )
              }
            />
            <SplitButtonV2 data-variant="outline">
              {/* With nothing staged the primary action commits every change, like Zed's "Commit Tracked". */}
              <SplitButtonV2Action
                disabled={git.busy || git.changes.length === 0 || !git.message.trim()}
                onClick={() =>
                  void runGit(
                    stagedCount() > 0 ? commit : () => stageAll().then(commit),
                    stagedCount() > 0 ? undefined : { optimistic: () => setStaged(true) },
                  )
                }
              >
                {language.t(stagedCount() > 0 ? "session.review.git.commit" : "session.review.git.commitAll")}
              </SplitButtonV2Action>
              <MenuV2 gutter={4} modal={false} placement="top-end">
                <MenuV2.Trigger
                  as={SplitButtonV2MenuTrigger}
                  disabled={git.busy || git.changes.length === 0 || !git.message.trim()}
                  aria-label={language.t("session.review.git.commitMenu")}
                >
                  <Icon name="chevron-down" size="small" />
                </MenuV2.Trigger>
                <MenuV2.Portal>
                  <MenuV2.Content>
                    <MenuV2.Item disabled={stagedCount() === 0} onSelect={() => void runGit(commit)}>
                      {language.t("session.review.git.commit")}
                    </MenuV2.Item>
                    <MenuV2.Item
                      onSelect={() => void runGit(() => stageAll().then(commit), { optimistic: () => setStaged(true) })}
                    >
                      {language.t("session.review.git.commitAll")}
                    </MenuV2.Item>
                  </MenuV2.Content>
                </MenuV2.Portal>
              </MenuV2>
            </SplitButtonV2>
          </div>
        </div>
        <Show when={git.error || git.loadError}>
          {(error) => (
            <div role="alert" class="text-12-regular text-text-danger">
              {error()}
            </div>
          )}
        </Show>
      </div>
    </Show>
  )

  const diffs = createMemo(() => props.diffs().filter(filterRenderableDiff))
  const filteredFiles = createMemo(() =>
    filterReviewFiles(
      props.gitChangesEnabled
        ? [...new Set([...diffs().map((diff) => diff.file), ...git.changes.map((change) => change.file)])]
        : diffs().map((diff) => diff.file),
      props.state.filter(),
    ),
  )
  const searching = createMemo(() => props.state.filter().trim().length > 0)
  const kinds = createMemo(() => reviewDiffKinds(diffs()))
  // Changes-only trees omit "M" — every row is already a change; A/D stay visible.
  const treeKinds = createMemo(() => new Map([...kinds()].filter(([, kind]) => kind !== "mix")))
  const activeDiff = createMemo(() => {
    // A focused comment takes over the preview until the preview applies it and
    // clears the focus; the owner then persists the file as the active selection.
    const focus = props.focusedComment
    if (focus && diffs().some((diff) => diff.file === focus.file)) return focus.file
    const active = props.activeFile
    if (searching()) return active
    const files = filteredFiles()
    if (active && files.includes(active)) return active
    return files[0]
  })
  const sourceActiveItem = createMemo(() => diffs().find((diff) => diff.file === activeDiff()))
  const detailSource = createMemo(() => {
    const diff = sourceActiveItem()
    const load = props.loadDiff
    if (!diff || !load || !reviewDiffNeedsLoad(diff)) return
    return { diff, load, version: props.diffVersion }
  })
  const [loadedDiff] = createResource(detailSource, async ({ diff, load, version }) => {
    const value = await load(diff.file, version)
    if (value?.file !== diff.file) return
    return { source: diff, version, value }
  })

  const activeItem = createMemo(() => {
    const source = sourceActiveItem()
    if (loadedDiff.state !== "ready") return source
    const loaded = loadedDiff()
    if (loaded && loaded.source === source && loaded.version === props.diffVersion) return loaded.value
    return source
  })

  const readFile = async (path: string) =>
    sdk()
      .client.file.read({ path })
      .then((x) => x.data)
      .catch((error) => {
        console.debug("[session-review-v2] failed to read file", { path, error })
        return undefined
      })

  return (
    <SessionReviewV2
      title={props.title}
      stats={<DiffChanges changes={diffs()} />}
      empty={props.empty}
      sidebarOpen={props.state.sidebarOpened()}
      sidebar={
        // Always mounted: the sidebar header hosts the changes-mode dropdown,
        // which must stay reachable when the current mode has zero diffs.
        <ReviewPanelV2Sidebar
          title={props.title}
          state={props.state}
          diffsReady={props.diffsReady}
          onSelectFile={props.onSelectFile}
          diffs={diffs}
          filteredFiles={filteredFiles}
          searching={searching}
          kinds={treeKinds}
          activeDiff={activeDiff}
          controls={gitControls}
          footer={gitFooter}
          fileAccessory={props.gitChangesEnabled ? fileAccessory : undefined}
        />
      }
      activeFile={activeDiff()}
      files={filteredFiles()}
      onSelectFile={props.onSelectFile}
      diffStyle={props.diffStyle}
      onDiffStyleChange={props.onDiffStyleChange}
      expandMode={props.state.expandMode()}
      onExpandModeChange={props.state.setExpandMode}
      hasDiffs={diffs().length > 0}
      preview={
        // Key on the file path, not the diff object identity, so refreshed diff data
        // updates the mounted preview instead of remounting the whole viewer.
        <Show when={activeDiff()} keyed>
          {(file) => (
            <Show when={activeItem()}>
              {(diff) => (
                <SessionReviewFilePreviewV2
                  file={file}
                  diff={diff()}
                  diffStyle={props.diffStyle}
                  expandMode={props.state.expandMode()}
                  readFile={readFile}
                  onLineComment={props.onLineComment}
                  onLineCommentUpdate={props.onLineCommentUpdate}
                  onLineCommentDelete={props.onLineCommentDelete}
                  lineCommentActions={props.lineCommentActions}
                  comments={props.comments}
                  focusedComment={props.focusedComment}
                  onFocusedCommentChange={props.onFocusedCommentChange}
                />
              )}
            </Show>
          )}
        </Show>
      }
    />
  )
}

function ReviewPanelV2Sidebar(props: {
  title?: JSX.Element
  state: ReviewPanelV2State
  diffsReady: () => boolean
  onSelectFile: (path: string) => void
  diffs: () => RenderDiff[]
  filteredFiles: () => string[]
  searching: () => boolean
  kinds: () => ReturnType<typeof reviewDiffKinds>
  activeDiff: () => string | undefined
  controls: () => JSX.Element
  footer: () => JSX.Element
  fileAccessory?: (path: string) => JSX.Element
}) {
  const language = useLanguage()
  const [explicitHighlight, setExplicitHighlight] = createSignal<string | undefined>()
  const highlightedPath = createMemo(() => {
    if (!props.searching()) return undefined
    const files = props.filteredFiles()
    if (files.length === 0) return undefined
    const explicit = explicitHighlight()
    if (explicit && files.includes(explicit)) return explicit
    return files[0]
  })

  const onFilterKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (!props.searching()) return
    applyFileListKeyDown(event, props.filteredFiles(), highlightedPath(), {
      onHighlight: setExplicitHighlight,
      onSelect: props.onSelectFile,
    })
  }

  return (
    <SessionReviewV2Sidebar
      open={props.state.sidebarOpened()}
      transition={props.state.sidebarTransition()}
      title={props.title}
      stats={<DiffChanges changes={props.diffs()} />}
      controls={props.controls()}
      footer={props.footer()}
      filter={props.state.filter()}
      onFilterChange={props.state.setFilter}
      onFilterKeyDown={onFilterKeyDown}
      width={props.state.sidebarWidth()}
      onWidthChange={props.state.resizeSidebar}
      minWidth={SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN}
      maxWidth={SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX}
    >
      <Show
        when={props.diffsReady()}
        fallback={
          <div class="px-2 py-2 text-12-regular text-text-weak">
            {language.t("common.loading")}
            {language.t("common.loading.ellipsis")}
          </div>
        }
      >
        <Show
          when={props.searching()}
          fallback={
            <FileTreeV2
              allowed={props.filteredFiles()}
              kinds={props.kinds()}
              draggable={false}
              active={props.activeDiff()}
              onFileClick={(node) => props.onSelectFile(node.path)}
              fileAccessory={props.fileAccessory}
            />
          }
        >
          <Show
            when={props.filteredFiles().length > 0}
            fallback={<div class="px-2 py-2 text-12-regular text-text-weak">{language.t("palette.empty")}</div>}
          >
            <SessionFileListV2
              files={props.filteredFiles()}
              kinds={props.kinds()}
              active={props.activeDiff()}
              highlighted={highlightedPath()}
              fileAccessory={props.fileAccessory}
              onFileClick={(path) => {
                setExplicitHighlight(path)
                props.onSelectFile(path)
              }}
            />
          </Show>
        </Show>
      </Show>
    </SessionReviewV2Sidebar>
  )
}
