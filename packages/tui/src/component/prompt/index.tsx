import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  MouseEvent,
  PasteEvent,
  decodePasteBytes,
  type KeyEvent,
} from "@opentui/core"
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, Show, Switch, Match, For } from "solid-js"
import path from "path"
import { useLocal } from "../../context/local"
import { useTheme, useThemes } from "../../context/theme"
import { tint } from "../../theme/color"
import { createAnimatable, tween } from "../../ui/animation"
import { EmptyBorder, SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { useClipboard } from "../../context/clipboard"
import { Spinner } from "../spinner"
import { useClient } from "../../context/client"
import { useRoute } from "../../context/route"
import { usePromptRef } from "../../context/prompt"
import { useSessionTabs } from "../../context/session-tabs"
import { useEvent } from "../../context/event"
import { editorSelectionKey, useEditorContext, type EditorSelection } from "../../context/editor"
import { normalizePromptContent, openEditor } from "../../editor"
import { useExit } from "../../context/exit"
import { displayOffsetIndex, promptOffsetWidth } from "../../prompt/display"
import { expandPromptInputPastedText, realignPromptInputMentions } from "../../prompt/mention"
import { parseSlashHead } from "../../prompt/parse"
import { stringWidth } from "../../util/string-width"
import { createStore, produce, unwrap } from "solid-js/store"
import { emptyPrompt, usePromptHistory, type PromptInfo, type PromptPartRef } from "../../prompt/history"
import { saveDraft, takeDraft } from "./draft-stash"
import { Skill } from "@opencode/schema/skill"
import { computePromptTraits } from "../../prompt/traits"
import { expandPastedTextPlaceholders, expandTrackedPastedText } from "../../prompt/part"
import { usePromptStash } from "../../prompt/stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteOption, type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Locale } from "../../util/locale"
import { errorMessage } from "../../util/error"
import { createColors, createFrames } from "../../ui/spinner"
import { useDialog } from "../../ui/dialog"
import { DialogIntegration } from "../dialog-integration"
import { useConnected } from "../use-connected"
import { useToast } from "../../ui/toast"
import { createFadeIn } from "../../util/signal"
import { DialogSkill } from "../dialog-skill"
import { useConfig } from "../../config"
import { usePromptMove } from "./move"
import { resolvePastedAttachments } from "./local-attachment"
import { locationKey, useData } from "../../context/data"
import { useLocation } from "../../context/location"
import { useArgs } from "../../context/args"
import { Keymap, type KeymapCommand } from "../../context/keymap"
import { useInteractivity } from "../../context/interactivity"
import { abbreviateHome } from "../../runtime"
import { Slot } from "../../plugin/render"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import {
  deduplicatePromptImages,
  preserveMentionlessPromptAttachments,
  promptAttachmentLabel,
} from "../../prompt/attachment"
import { DialogImagePreview } from "../dialog-image-preview"
import { useDirectoryRecents } from "../../prompt/directory-recents"
import { directoryRecentValue } from "../../prompt/directory-completion"
import { useWorkingDirectoryActions } from "../../ui/working-directory-actions"
import { truncateFilePath } from "../../ui/file-path"
import { PromptMetadataRow } from "./metadata"

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  muted?: boolean
  onSubmit?: () => void
  onEmptySubmit?: () => boolean | Promise<boolean>
  ref?: (ref: PromptRef | undefined) => void
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  mode: "normal" | "shell"
  setMode(mode: "normal" | "shell"): void
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const DRAFT_RETENTION_MIN_CHARS = 20
const revealedPromptMetadata = new WeakSet<object>()

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

export function PromptInterruptStatus(props: {
  armed: boolean
  animations?: boolean
  text: RGBA
  subdued: RGBA
  warning: RGBA
  flash?: RGBA
}) {
  const ignition = createAnimatable(
    { level: 0 },
    { enabled: () => props.animations ?? false, transition: tween({ duration: 0.22 }) },
  )
  createEffect(
    on(
      () => props.armed,
      (armed) => {
        if (!armed || !props.animations) return ignition.jump({ level: 0 })
        ignition.jump({ level: 0.75 })
        ignition.animate({ level: 0 })
      },
      { defer: true },
    ),
  )
  const armedColor = createMemo(() => {
    const level = ignition.value().level
    if (level === 0 || !props.flash) return props.warning
    return tint(props.warning, props.flash, level)
  })

  return (
    <text fg={props.armed ? armedColor() : props.text} wrapMode="none" truncate flexShrink={1}>
      esc{" "}
      <span style={{ fg: props.armed ? armedColor() : props.subdued }}>
        {props.armed ? "again to interrupt" : "interrupt"}
      </span>
    </text>
  )
}

function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter(hasEditorRangeSelection)
  if (selected.length === 0)
    return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`

  const ranges = selected.map((range, index) => {
    const prefix = selected.length > 1 ? `Selection ${index + 1}: ` : ""
    return `Note: The user selected ${prefix}${getEditorRangeLabel(range)} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })

  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}

function argumentSlash(input: string, commands: readonly KeymapCommand[]) {
  const head = parseSlashHead(input, /\s/)
  if (!head) return
  const command = commands.find(
    (command) =>
      command.slash?.arguments &&
      (command.slash.name === head.name || command.slash.aliases?.includes(head.name) === true),
  )
  if (!command) return
  return { command, input: head.arguments }
}

type VimOperator = "d" | "c" | "y" | ">" | "<" | "~"
type VimFindKind = "t" | "f" | "T" | "F"
type VimMotionSpec = { type: "motion"; key: string } | { type: "object"; around: boolean; char: string }
type VimPending =
  | { kind: "g"; op?: VimOperator; count?: number }
  | { kind: "operator"; op: VimOperator; count: number }
  | { kind: "find"; op?: VimOperator; count: number; find: VimFindKind }
  | { kind: "textobject"; op: VimOperator; count: number; around: boolean }
  | { kind: "replace"; count: number }
type VimResolved = { range: { start: number; end: number }; linewise: boolean }
type VimOperatorChange = { kind: "operator"; op: VimOperator; count: number; motion: VimMotionSpec; insert?: string }
type VimLastChange =
  | VimOperatorChange
  | { kind: "simple"; key: string; count: number }
  | { kind: "replace"; char: string; count: number }
  | { kind: "insert"; text: string }

const VIM_BRACKETS: Record<string, [string, string]> = {
  "(": ["(", ")"],
  ")": ["(", ")"],
  "[": ["[", "]"],
  "]": ["[", "]"],
  "{": ["{", "}"],
  "}": ["{", "}"],
  "<": ["<", ">"],
  ">": ["<", ">"],
}

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()

  const enabled = useInteractivity()
  const disabled = () => props.disabled || !enabled()
  const leader = Keymap.useLeaderActive()
  const muted = () => leader() || props.muted
  const local = useLocal()
  const paths = useTuiPaths()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const clipboard = useClipboard()
  const client = useClient()
  const editor = useEditorContext()
  const route = useRoute()
  const promptRef = usePromptRef()
  const sessionTabs = useSessionTabs()
  const data = useData()
  const directoryRecents = useDirectoryRecents()
  const keymapCommands = Keymap.useCommands()
  const currentLocation = useLocation()
  const args = useArgs()
  const config = useConfig().data
  const [vimMode, setVimMode] = createSignal<"insert" | "normal" | "visual">("insert")
  const [vimPending, setVimPending] = createSignal<VimPending>()
  const [vimCount, setVimCount] = createSignal(0)
  const [vimVisualKind, setVimVisualKind] = createSignal<"char" | "line">("char")
  const [vimVisualAnchor, setVimVisualAnchor] = createSignal(0)
  const [vimRegister, setVimRegister] = createSignal<{ text: string; linewise: boolean }>({ text: "", linewise: false })
  const [vimLastChange, setVimLastChange] = createSignal<VimLastChange>()
  const [vimLastFind, setVimLastFind] = createSignal<{ find: VimFindKind; char: string }>()
  const [vimLastVisual, setVimLastVisual] = createSignal<{ anchor: number; cursor: number; kind: "char" | "line" }>()
  // Insert-session bookkeeping for `.`; intentionally non-reactive.
  let vimInsertOrigin: number | undefined
  let vimInsertOperator: VimOperatorChange | undefined
  const vimEnabled = () => config.prompt?.vim !== false
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => data.session.status(props.sessionID ?? ""))
  const history = usePromptHistory()
  const stash = usePromptStash()
  const keymap = Keymap.use()
  const renderer = useRenderer()
  const exit = useExit()
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const animationsEnabled = createMemo(() => config.animations ?? true)
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const fileContextEnabled = createMemo(() => config.prompt?.editor ?? true)
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const editorPath = createMemo(() => editorContext()?.filePath)
  const editorSelectionLabel = createMemo(() => {
    const ranges = editorContext()?.ranges
    if (!ranges) return
    const first = ranges.find(hasEditorRangeSelection) ?? ranges[0]
    if (!first) return
    return [getEditorRangeLabel(first), ranges.length > 1 ? `+${ranges.length - 1}` : undefined]
      .filter(Boolean)
      .join(" ")
  })
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })
  const editorContextLabelState = createMemo(() => editor.labelState())
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const move = usePromptMove({
    projectID: () =>
      (props.sessionID ? data.session.get(props.sessionID)?.projectID : undefined) ?? data.location.info()?.project.id,
    sessionID: () => props.sessionID,
  })
  const [pendingDirectory, setPendingDirectory] = createSignal<string>()
  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !disabled(),
    commands: [
      {
        id: "session.cd",
        title: "Change working directory",
        slash: { name: "cd", arguments: true },
        run: async (input) => {
          if (!input?.trim()) {
            toast.show({ message: "Directory is required", variant: "error" })
            return
          }
          const sessionID = props.sessionID
          const session = sessionID ? data.session.get(sessionID) : undefined
          const sourceProjectID = session?.projectID ?? data.location.info()?.project.id
          const value = input.trim()
          const expanded =
            value === "~" ? paths.home : value.startsWith("~/") ? path.join(paths.home, value.slice(2)) : value
          const directory = path.resolve(
            session?.location.directory ?? currentLocation.current?.directory ?? data.location.default().directory,
            expanded,
          )
          if (!sessionID) {
            setPendingDirectory(directory)
            const location = await client.api.location.get({ location: { directory } }).catch((error) => {
              toast.show({ title: "Failed to change directory", message: errorMessage(error), variant: "error" })
              return undefined
            })
            if (!location) {
              setPendingDirectory(undefined)
              return
            }
            if (sourceProjectID) directoryRecents.touch(sourceProjectID, location.directory)
            currentLocation.set(location)
            setPendingDirectory(undefined)
            return
          }
          const error = await client.api.session.move({ sessionID, directory: input }).then(
            () => undefined,
            (error) => error,
          )
          if (error) {
            toast.show({ title: "Failed to change directory", message: errorMessage(error), variant: "error" })
            return
          }
          if (sourceProjectID) directoryRecents.touch(sourceProjectID, directory)
        },
      },
    ],
  }))
  const [cursorVersion, setCursorVersion] = createSignal(0)
  const connected = useConnected()

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect an integration to send prompts",
      duration: 3000,
    })
    if (!connected()) {
      dialog.replace(() => <DialogIntegration />)
    }
  }

  function dismissEditorContext() {
    setDismissedEditorSelectionKey(editorSelectionKey(editorContext()))
    editor.clearSelection()
  }
  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const skillStyleId = syntax().getStyleId("extmark.skill")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  const event = useEvent()

  event.on("tui.prompt.append", (evt, { directory }) => {
    if (directory !== (currentLocation.current?.directory ?? data.location.default().directory)) return
    if (!input || input.isDestroyed) return
    input.insertText(evt.data.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.cursorColor = disabled() ? theme.background.raised.base : theme.text.base
    const style = vimEnabled() && vimMode() !== "insert" ? { style: "block" as const, blinking: false } : config.cursor
    if (style) input.cursorStyle = style
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPart: Map<number, PromptPartRef>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: emptyPrompt(),
    mode: "normal",
    extmarkToPart: new Map(),
    interrupt: 0,
  })
  let disposed = false
  let pasteQueue = Promise.resolve()

  function enqueuePaste(run: (changed: () => boolean) => Promise<void>) {
    pasteQueue = pasteQueue
      .then(async () => {
        if (disposed || input.isDestroyed || disabled()) return
        const before = { sessionID: props.sessionID, mode: store.mode, text: input.plainText }
        await run(
          () =>
            disposed ||
            input.isDestroyed ||
            disabled() ||
            props.sessionID !== before.sessionID ||
            store.mode !== before.mode ||
            input.plainText !== before.text,
        )
      })
      .catch((error) => {
        if (!disposed) toast.error(error)
      })
    return pasteQueue
  }

  const imageAttachments = createMemo(() =>
    (deduplicatePromptImages(store.prompt.files) ?? []).filter((file) => file.uri.startsWith("data:image/")),
  )
  const imagePreviewHeight = createMemo(() => Math.max(4, Math.min(8, Math.floor(dimensions().height / 4))))
  const imagePreviewWidth = createMemo(() => imagePreviewHeight() * 2)
  const visibleImageAttachments = createMemo(() => imageAttachments().slice(0, 3))

  function openImagePreview(initial: number) {
    const images = imageAttachments()
    if (images.length === 0) return
    dialog.replace(() => <DialogImagePreview images={images} initial={initial} />)
  }

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
        setVimMode("insert")
        setVimPending(undefined)
        setVimCount(0)
        if (input && !input.isDestroyed) input.clearSelection()
      },
      { defer: true },
    ),
  )

  const promptCommands = createMemo(() =>
    [
      {
        title: "Clear prompt",
        name: "prompt.clear",
        category: "Prompt",
        palette: undefined,
        run: () => {
          clearPrompt()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        name: "prompt.submit",
        category: "Prompt",
        palette: undefined,
        run: async (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Queue prompt",
        name: "prompt.queue",
        category: "Prompt",
        run: async (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          if (!input.focused) return
          if (auto()?.visible && !auto()?.completeQueueableCommand()) return
          const handled = await submit("queue")
          if (!handled) return
          dialog.clear()
        },
      },
      {
        title: "Remove editor context",
        name: "prompt.editor_context.clear",
        category: "Prompt",
        enabled: Boolean(editorContext()),
        run: () => {
          dismissEditorContext()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        name: "prompt.paste",
        category: "Prompt",
        palette: undefined,
        run: (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          return enqueuePaste(async (changed) => {
            const content = await clipboard.read()
            if (changed()) return
            if (content?.mime.startsWith("image/")) {
              pasteAttachment({
                filename: "clipboard",
                uri: `data:${content.mime};base64,${content.data}`,
              })
              return
            }
            if (content?.mime === "text/plain") {
              await pasteInputText(content.data, changed)
            }
          })
        },
      },
      {
        title: "View image attachments",
        name: "prompt.images.view",
        category: "Prompt",
        enabled: imageAttachments().length > 0,
        run: () => openImagePreview(0),
      },
      {
        title: "Interrupt session",
        name: "session.interrupt",
        category: "Session",
        palette: undefined,
        enabled: status() === "running",
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            void client.api.session.interrupt({
              sessionID: props.sessionID,
              resume: true,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "Background blocking tools",
        name: "session.background",
        category: "Session",
        palette: undefined,
        enabled: status() === "running",
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          if (!props.sessionID) return

          void client.api.session.background({
            sessionID: props.sessionID,
          })
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        name: "prompt.editor",
        slash: { name: "editor" },
        run: async () => {
          dialog.clear()

          const editorPrompt = expandPromptInputPastedText(store.prompt, store.prompt.pasted)
          const value = editorPrompt.text
          const content = await openEditor({
            renderer,
            value,
            cwd:
              (data.location.info()?.project.directory === "/" ? undefined : data.location.info()?.project.directory) ||
              data.location.default().directory ||
              paths.cwd,
          }).catch((error) => {
            toast.show({ title: "Failed to open editor", message: errorMessage(error), variant: "error" })
          })
          if (!content) return
          const normalized = normalizePromptContent(content)

          input.setText(normalized)

          setStore("prompt", {
            ...realignPromptInputMentions(normalized, editorPrompt),
            pasted: [],
          })
          restoreExtmarksFromPrompt(store.prompt)
          input.cursorOffset = stringWidth(normalized)
        },
      },
      {
        title: "Skills",
        name: "prompt.skills",
        category: "Prompt",
        slash: { name: "skills" },
        run: () => {
          dialog.replace(() => (
            <DialogSkill
              location={currentLocation.ref}
              onSelect={(skill) => {
                if (store.prompt.skills?.some((item) => item.id === skill)) return
                const text = `@${skill}`
                const start = input.cursorOffset
                input.insertText(text + " ")
                const extmarkId = input.extmarks.create({
                  start,
                  end: start + promptOffsetWidth(text),
                  virtual: true,
                  styleId: skillStyleId,
                  typeId: promptPartTypeId,
                })
                setStore(
                  produce((draft) => {
                    draft.prompt.text = input.plainText
                    const skills = (draft.prompt.skills ??= [])
                    const index = skills.length
                    skills.push({
                      id: Skill.ID.make(skill),
                      mention: { start, end: start + promptOffsetWidth(text), text },
                    })
                    draft.extmarkToPart.set(extmarkId, { type: "skill", index })
                  }),
                )
              }}
            />
          ))
        },
      },
      {
        title: "Manage workspaces",
        desc: "Manage workspaces",
        name: "session.move",
        category: "Session",
        slash: { name: "worktrees" },
        run: () => {
          move.open()
        },
      },
    ].map(
      ({ name, category, ...command }) =>
        ({
          id: name,
          group: category,
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !disabled(),
    commands: promptCommands(),
  }))

  Keymap.createLayer(() => ({
    priority: 1,
    enabled: !disabled(),
    bindings: ["prompt.queue"],
  }))

  Keymap.createLayer(() => ({
    enabled: !disabled(),
    bindings: [
      "prompt.submit",
      "prompt.editor",
      "prompt.editor_context.clear",
      "prompt.images.view",
      "prompt.stash",
      "prompt.stash.pop",
      "prompt.stash.list",
      "prompt.skills",
      "session.interrupt",
      "session.background",
      "session.move",
    ],
  }))

  const ref: PromptRef = {
    get focused() {
      return !disabled() && input.focused
    },
    get current() {
      return store.prompt
    },
    get mode() {
      return store.mode
    },
    focus() {
      if (disabled()) return
      input.focus()
    },
    blur() {
      input.blur()
    },
    setMode(mode) {
      setStore("mode", mode)
    },
    set(prompt) {
      input.setText(prompt.text)
      setStore("prompt", prompt)
      restoreExtmarksFromPrompt(prompt)
      input.gotoBufferEnd()
      setVimMode("insert")
      setVimPending(undefined)
      setVimCount(0)
    },
    reset() {
      resetComposer()
    },
    submit() {
      void submit()
    },
  }

  function resetComposer() {
    input.extmarks.clear()
    setStore("prompt", emptyPrompt())
    setStore("extmarkToPart", new Map())
    input.clear()
    setVimMode("insert")
    setVimPending(undefined)
    setVimCount(0)
  }

  // Captured once: the session route is keyed by sessionID, so this Prompt
  // instance belongs to exactly one tab. Reading props.sessionID lazily would
  // observe the *next* route during onCleanup and stash under the wrong tab.
  const stashSessionID = props.sessionID

  onMount(() => {
    const saved = takeDraft(stashSessionID)
    if (store.prompt.text) return
    if (saved && saved.prompt.text) {
      input.setText(saved.prompt.text)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromPrompt(saved.prompt)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    disposed = true
    if (store.prompt.text) {
      saveDraft(stashSessionID, { prompt: unwrap(store.prompt), cursor: input.cursorOffset })
    }
    setInputTarget(undefined)
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || disabled() || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      input.focusable = false
      return
    }

    input.focusable = true
    // Slot/plugin updates can remount the background prompt while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = {
      ...input.traits,
      ...computePromptTraits({
        mode: store.mode,
        autocompleteVisible: !!auto()?.visible,
      }),
    }
  })

  function restoreExtmarksFromPrompt(prompt: PromptInfo) {
    input.extmarks.clear()
    setStore("extmarkToPart", new Map())

    const parts = [
      ...(prompt.files ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "file" as const, index },
        styleId: fileStyleId,
      })),
      ...(prompt.agents ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "agent" as const, index },
        styleId: agentStyleId,
      })),
      ...(prompt.skills ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "skill" as const, index },
        styleId: skillStyleId,
      })),
      ...prompt.pasted.map((part, index) => ({
        mention: part.source,
        ref: { type: "pasted" as const, index },
        styleId: pasteStyleId,
      })),
    ]

    parts.forEach(({ mention, ref, styleId }) => {
      if (mention?.text) {
        const extmarkId = input.extmarks.create({
          start: mention.start,
          end: mention.end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPart", (map: Map<number, PromptPartRef>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, ref)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, PromptPartRef>()
        const fileExtmarks = new Map<number, NonNullable<PromptInfo["files"]>[number]>()
        const files: NonNullable<PromptInfo["files"]> = []
        const agents: NonNullable<PromptInfo["agents"]> = []
        const skills: NonNullable<PromptInfo["skills"]> = []
        const pasted: PromptInfo["pasted"] = []

        for (const extmark of allExtmarks) {
          const ref = draft.extmarkToPart.get(extmark.id)
          if (!ref) continue
          if (ref.type === "file") {
            const part = draft.prompt.files?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            files.push(part)
            fileExtmarks.set(extmark.id, part)
            continue
          }
          if (ref.type === "agent") {
            const part = draft.prompt.agents?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            const index = agents.length
            agents.push(part)
            newMap.set(extmark.id, { type: "agent", index })
            continue
          }
          if (ref.type === "skill") {
            const part = draft.prompt.skills?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            const index = skills.length
            skills.push(part)
            newMap.set(extmark.id, { type: "skill", index })
            continue
          }
          const part = draft.prompt.pasted[ref.index]
          if (!part) continue
          part.source.start = extmark.start
          part.source.end = extmark.end
          const index = pasted.length
          pasted.push(part)
          newMap.set(extmark.id, { type: "pasted", index })
        }

        const nextFiles = preserveMentionlessPromptAttachments(draft.prompt.files, files)
        const fileIndices = new Map(nextFiles.map((file, index) => [file, index]))
        for (const [extmark, file] of fileExtmarks) {
          const index = fileIndices.get(file)
          if (index !== undefined) newMap.set(extmark, { type: "file", index })
        }

        draft.extmarkToPart = newMap
        if (
          nextFiles.length !== draft.prompt.files?.length ||
          nextFiles.some((file, index) => file !== draft.prompt.files?.[index])
        )
          draft.prompt.files = nextFiles
        draft.prompt.agents = agents
        draft.prompt.skills = skills
        draft.prompt.pasted = pasted
      }),
    )
  }

  const stashCommands = createMemo(() =>
    [
      {
        title: "Stash prompt",
        name: "prompt.stash",
        category: "Prompt",
        enabled: !!store.prompt.text,
        run: () => {
          if (!store.prompt.text) return
          stash.push({ prompt: store.prompt })
          resetComposer()
          dialog.clear()
        },
      },
      {
        title: "Stash pop",
        name: "prompt.stash.pop",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          const entry = stash.pop()
          if (entry) {
            input.setText(entry.prompt.text)
            setStore("prompt", entry.prompt)
            restoreExtmarksFromPrompt(entry.prompt)
            input.gotoBufferEnd()
          }
          dialog.clear()
        },
      },
      {
        title: "Stash list",
        name: "prompt.stash.list",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          dialog.replace(() => (
            <DialogStash
              onSelect={(entry) => {
                input.setText(entry.prompt.text)
                setStore("prompt", entry.prompt)
                restoreExtmarksFromPrompt(entry.prompt)
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
    ].map(
      ({ name, category, ...command }) =>
        ({
          id: name,
          group: category,
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !disabled(),
    commands: stashCommands(),
  }))

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !disabled(),
      bindings: ["prompt.paste"],
    }
  })

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !disabled() && store.prompt.text !== "",
      bindings: ["prompt.clear"],
    }
  })

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return (
          inputTarget() !== undefined &&
          !disabled() &&
          store.mode === "normal" &&
          !auto()?.visible &&
          input?.visualCursor.offset === 0
        )
      })(),
      commands: [
        {
          bind: "!",
          title: "Shell mode",
          group: "Prompt",
          run: () => {
            setStore("placeholder", randomIndex(shell().length))
            setStore("mode", "shell")
          },
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: inputTarget() !== undefined && !disabled() && store.mode === "shell",
      commands: [
        { bind: "escape", title: "Exit shell mode", group: "Prompt", run: () => setStore("mode", "normal") },
        {
          bind: "ctrl+c",
          title: "Exit shell mode",
          group: "Prompt",
          enabled: () => store.prompt.text === "",
          run: () => setStore("mode", "normal"),
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !disabled() && store.mode === "shell" && input?.visualCursor.offset === 0
      })(),
      commands: [
        { bind: "backspace", title: "Exit shell mode", group: "Prompt", run: () => setStore("mode", "normal") },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled:
        inputTarget() !== undefined &&
        !disabled() &&
        vimEnabled() &&
        vimMode() === "insert" &&
        store.mode === "normal" &&
        !auto()?.visible,
      commands: [
        {
          bind: "escape",
          title: "Enter Vim normal mode",
          group: "Prompt",
          run: () => {
            if (!input || input.isDestroyed) return
            vimLeaveInsert()
            setVimMode("normal")
            setVimPending(undefined)
            setVimCount(0)
            input.moveCursorLeft()
          },
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !disabled() && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          id: "prompt.history.previous",
          title: "Previous prompt history",
          group: "Prompt",
          run() {
            if (input.cursorOffset !== 0) {
              if (input.scrollY + input.visualCursor.visualRow === 0) {
                input.cursorOffset = 0
                return
              }
              input.moveCursorUp()
              return
            }

            const item = history.move(-1, input.plainText)
            if (!item) return false
            input.setText(item.text)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromPrompt(item)
            input.cursorOffset = 0
          },
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !disabled() && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          id: "prompt.history.next",
          title: "Next prompt history",
          group: "Prompt",
          run() {
            if (input.cursorOffset !== input.plainText.length) {
              if (
                input.scrollY + input.visualCursor.visualRow ===
                Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
              ) {
                input.cursorOffset = input.plainText.length
                return
              }
              input.moveCursorDown()
              return
            }

            const item = history.move(1, input.plainText)
            if (!item) return false
            input.setText(item.text)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromPrompt(item)
            input.cursorOffset = input.plainText.length
          },
        },
      ],
    }
  })

  let submitting = false

  // OpenTUI cursor and selection offsets count display columns, while the Vim
  // helpers index the plain string by code unit. Convert at this boundary.
  function vimCaret() {
    return displayOffsetIndex(input.plainText, input.cursorOffset)
  }

  function vimSetCaret(index: number) {
    input.cursorOffset = promptOffsetWidth(input.plainText.slice(0, index))
  }

  function vimCell(index: number) {
    return promptOffsetWidth(input.plainText.slice(0, index))
  }

  function vimHistory(direction: 1 | -1, times: number) {
    for (let step = 0; step < times; step++) {
      const item = history.move(direction, input.plainText)
      if (!item) return
      input.setText(item.text)
      setStore("prompt", item)
      setStore("mode", item.mode ?? "normal")
      restoreExtmarksFromPrompt(item)
      vimSetCaret(direction === -1 ? 0 : input.plainText.length)
    }
  }

  function vimOffsetToPos(offset: number) {
    const before = input.plainText.slice(0, offset)
    const lineStart = before.lastIndexOf("\n") + 1
    return { row: before.match(/\n/g)?.length ?? 0, col: promptOffsetWidth(before.slice(lineStart)) }
  }

  function vimDeleteRange(start: number, end: number) {
    if (end <= start) return false
    const from = vimOffsetToPos(start)
    const to = vimOffsetToPos(end)
    input.deleteRange(from.row, from.col, to.row, to.col)
    return true
  }

  function vimStarts(text: string) {
    return [0, ...[...text.matchAll(/\n/g)].map((match) => (match.index ?? 0) + 1)]
  }

  function vimRowStarts() {
    return vimStarts(input.plainText)
  }

  function vimRow(offset: number) {
    return input.plainText.slice(0, offset).match(/\n/g)?.length ?? 0
  }

  function vimLineStart(offset: number) {
    return input.plainText.lastIndexOf("\n", offset - 1) + 1
  }

  function vimLineEnd(offset: number) {
    const index = input.plainText.indexOf("\n", offset)
    return index === -1 ? input.plainText.length : index
  }

  function vimFirstNonBlankOffset(offset: number) {
    const start = vimLineStart(offset)
    const line = input.plainText.slice(start, vimLineEnd(offset))
    return start + (line.match(/^[ \t]*/)?.[0].length ?? 0)
  }

  function vimFirstNonBlank() {
    vimSetCaret(vimFirstNonBlankOffset(vimCaret()))
  }

  function vimIsSpace(char: string | undefined) {
    return char === undefined || /\s/.test(char)
  }

  function vimRepeat(times: number, fn: () => void) {
    for (let step = 0; step < times; step++) fn()
  }

  function vimWordForwardOffset(offset: number, times: number) {
    const text = input.plainText
    let index = offset
    for (let step = 0; step < times; step++) {
      index++
      while (index < text.length && vimIsSpace(text[index])) index++
    }
    return Math.min(index, text.length)
  }

  function vimWordBackwardOffset(offset: number, times: number) {
    const text = input.plainText
    let index = offset
    for (let step = 0; step < times; step++) {
      index = Math.max(0, index - 1)
      while (index > 0 && vimIsSpace(text[index])) index--
      while (index > 0 && !vimIsSpace(text[index - 1])) index--
    }
    return index
  }

  function vimWordEndOffset(offset: number, times = 1) {
    const text = input.plainText
    let index = offset
    for (let step = 0; step < times; step++) {
      // On the last character of a word, `e` advances to the end of the next word.
      if (!vimIsSpace(text[index]) && vimIsSpace(text[index + 1])) {
        index++
        while (index < text.length && vimIsSpace(text[index])) index++
      }
      if (index >= text.length) return text.length
      while (index + 1 < text.length && !vimIsSpace(text[index + 1])) index++
      if (step + 1 < times) index = Math.min(index + 1, text.length)
    }
    return index
  }

  function vimMoveCapture(move: () => void) {
    const start = input.cursorOffset
    move()
    const end = displayOffsetIndex(input.plainText, input.cursorOffset)
    input.cursorOffset = start
    return end
  }

  function vimLinewiseLineRange(first: number, last: number) {
    const text = input.plainText
    const starts = vimRowStarts()
    const lo = Math.max(0, Math.min(first, last))
    const hi = Math.min(starts.length - 1, Math.max(first, last))
    const end = hi + 1 < starts.length ? (starts[hi + 1] ?? text.length) : text.length
    // Reaching the buffer end drops the preceding newline so deleting trailing
    // lines does not leave an empty last line behind.
    const start = end === text.length && (starts[lo] ?? 0) > 0 ? (starts[lo] ?? 0) - 1 : (starts[lo] ?? 0)
    return { start, end }
  }

  function vimDoubledRange(count: number) {
    const row = vimRow(vimCaret())
    return { range: vimLinewiseLineRange(row, row + (count || 1) - 1), linewise: true }
  }

  function vimMotionRange(motion: string, count: number): VimResolved | undefined {
    const cursor = vimCaret()
    const clamp = (value: number) => Math.max(0, Math.min(value, input.plainText.length))
    const charwise = (start: number, end: number): VimResolved => ({
      range: { start: clamp(Math.min(start, end)), end: clamp(Math.max(start, end)) },
      linewise: false,
    })
    switch (motion) {
      case "h":
        return charwise(cursor - (count || 1), cursor)
      case "l":
      case " ":
        return charwise(cursor, Math.min(vimLineEnd(cursor), cursor + (count || 1)))
      case "w":
        return charwise(
          cursor,
          vimMoveCapture(() => vimRepeat(count || 1, () => input.moveWordForward())),
        )
      case "W":
        return charwise(cursor, vimWordForwardOffset(cursor, count || 1))
      case "b":
        return charwise(
          vimMoveCapture(() => vimRepeat(count || 1, () => input.moveWordBackward())),
          cursor,
        )
      case "B":
        return charwise(vimWordBackwardOffset(cursor, count || 1), cursor)
      case "e":
      case "E":
        return charwise(cursor, Math.min(vimWordEndOffset(cursor, count || 1) + 1, vimLineEnd(cursor)))
      case "0":
        return charwise(vimLineStart(cursor), cursor)
      case "^":
        return charwise(vimFirstNonBlankOffset(cursor), cursor)
      case "$":
        return charwise(cursor, vimLineEnd(cursor))
      case "s":
        return charwise(cursor, Math.min(vimLineEnd(cursor), cursor + (count || 1)))
      case "j": {
        const row = vimRow(cursor)
        return { range: vimLinewiseLineRange(row, row + (count || 1)), linewise: true }
      }
      case "k": {
        const row = vimRow(cursor)
        return { range: vimLinewiseLineRange(row - (count || 1), row), linewise: true }
      }
      case "G":
        return {
          range: vimLinewiseLineRange(vimRow(cursor), count ? count - 1 : vimRowStarts().length - 1),
          linewise: true,
        }
      case "gg":
        return { range: vimLinewiseLineRange(count ? count - 1 : 0, vimRow(cursor)), linewise: true }
      default:
        return undefined
    }
  }

  function vimFindIndex(char: string, find: VimFindKind, times: number) {
    const cursor = vimCaret()
    let index = cursor
    if (find === "f" || find === "t") {
      for (let step = 0; step < times; step++) {
        index = input.plainText.indexOf(char, index + 1)
        if (index === -1 || index >= vimLineEnd(cursor)) return undefined
      }
      return index
    }
    for (let step = 0; step < times; step++) {
      index = input.plainText.lastIndexOf(char, index - 1)
      if (index === -1 || index < vimLineStart(cursor)) return undefined
    }
    return index
  }

  function vimApplyFind(op: VimOperator | undefined, find: VimFindKind, char: string, count: number) {
    const index = vimFindIndex(char, find, count || 1)
    if (index === undefined) {
      setVimCount(0)
      return
    }
    if (op) {
      const cursor = vimCaret()
      const range =
        find === "f"
          ? { start: cursor, end: index + 1 }
          : find === "t"
            ? { start: cursor, end: index }
            : find === "F"
              ? { start: index, end: cursor }
              : { start: index + 1, end: cursor }
      vimApplyResolved(op, { range, linewise: false }, { type: "motion", key: find }, count)
    } else {
      const cursor = vimCaret()
      if (find === "f" || find === "F") vimSetCaret(index)
      else if (find === "t") vimSetCaret(Math.max(vimLineStart(index), index - 1))
      else vimSetCaret(Math.min(vimLineEnd(cursor), index + 1))
    }
    setVimLastFind({ find, char })
    setVimCount(0)
  }

  function vimToggleRange(range: { start: number; end: number }) {
    const text = input.plainText
    const toggled = text
      .slice(range.start, range.end)
      .replace(/[a-zA-Z]/g, (char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()))
    input.setText(text.slice(0, range.start) + toggled + text.slice(range.end))
  }

  function vimIndentRange(range: { start: number; end: number }, indent: boolean) {
    const text = input.plainText
    const firstRow = vimRow(range.start)
    // Linewise ranges aimed at the buffer end start on the preceding newline.
    const first = text[range.start] === "\n" ? firstRow + 1 : firstRow
    const last = vimRow(Math.max(range.start, range.end - 1))
    const lines = text.split("\n")
    for (let row = first; row <= last; row++) {
      lines[row] = indent ? "  " + (lines[row] ?? "") : (lines[row] ?? "").replace(/^ {1,2}|^\t/, "")
    }
    const next = lines.join("\n")
    input.setText(next)
    vimSetCaret(vimFirstNonBlankOffset(vimStarts(next)[first] ?? 0))
  }

  function vimReplaceChar(char: string, count: number) {
    const cursor = vimCaret()
    const end = Math.min(vimLineEnd(cursor), cursor + (count || 1))
    if (end <= cursor) return
    const text = input.plainText
    input.setText(text.slice(0, cursor) + char.repeat(end - cursor) + text.slice(end))
    vimSetCaret(cursor)
    setVimLastChange({ kind: "replace", char, count: count || 1 })
  }

  function vimJoinLines(count: number) {
    let cursor = vimCaret()
    let next = input.plainText
    for (let step = 0; step < (count || 1); step++) {
      const newline = next.indexOf("\n", cursor)
      if (newline === -1) break
      let after = newline + 1
      while (after < next.length && (next[after] === " " || next[after] === "\t")) after++
      next = next.slice(0, newline) + " " + next.slice(after)
      cursor = newline
    }
    input.setText(next)
    vimSetCaret(cursor)
  }

  function vimPaste(after: boolean, count: number) {
    const register = vimRegister()
    if (!register.text) return
    const text = input.plainText
    const caret = vimCaret()
    const times = count || 1
    if (register.linewise) {
      const chunk = register.text.repeat(times)
      const lineEnd = vimLineEnd(caret)
      const atBufferEnd = after && lineEnd >= text.length
      const insertAt = after ? (atBufferEnd ? text.length : lineEnd + 1) : vimLineStart(caret)
      const body = chunk.endsWith("\n") ? chunk : chunk + "\n"
      const payload = atBufferEnd ? "\n" + body : body
      input.setText(text.slice(0, insertAt) + payload + text.slice(insertAt))
      vimSetCaret(vimFirstNonBlankOffset(atBufferEnd ? insertAt + 1 : insertAt))
      return
    }
    const at = after ? Math.min(text.length, caret + 1) : caret
    const payload = register.text.repeat(times)
    input.setText(text.slice(0, at) + payload + text.slice(at))
    vimSetCaret(at + payload.length - 1)
  }

  function vimWordObject(cursor: number, count: number, around: boolean): VimResolved {
    const text = input.plainText
    const onWord = !vimIsSpace(text[cursor])
    const same = (index: number) => !vimIsSpace(text[index]) === onWord
    let start = cursor
    let end = Math.min(cursor + 1, text.length)
    while (start > 0 && same(start - 1)) start--
    while (end < text.length && same(end)) end++
    for (let step = 1; step < count; step++) {
      while (end < text.length && vimIsSpace(text[end])) end++
      while (end < text.length && !vimIsSpace(text[end])) end++
    }
    if (around) {
      const trailing = end
      while (end < text.length && vimIsSpace(text[end])) end++
      if (end === trailing) {
        while (start > 0 && vimIsSpace(text[start - 1])) start--
      }
    }
    return { range: { start, end: Math.max(start, end) }, linewise: false }
  }

  function vimQuoteObject(cursor: number, quote: string, around: boolean): VimResolved | undefined {
    const text = input.plainText
    const lineStart = vimLineStart(cursor)
    const lineEnd = vimLineEnd(cursor)
    const positions: number[] = []
    for (let index = lineStart; index < lineEnd; index++) {
      if (text[index] === quote && text[index - 1] !== "\\") positions.push(index)
    }
    let open = -1
    let close = -1
    for (let index = 0; index + 1 < positions.length; index += 2) {
      const left = positions[index]
      const right = positions[index + 1]
      if (left === undefined || right === undefined) continue
      if (left <= cursor && cursor <= right) {
        open = left
        close = right
        break
      }
    }
    if (open === -1) {
      for (let index = 0; index + 1 < positions.length; index += 2) {
        const left = positions[index]
        const right = positions[index + 1]
        if (left === undefined || right === undefined) continue
        if (left >= cursor) {
          open = left
          close = right
          break
        }
      }
    }
    if (open === -1 && positions.length >= 2) {
      open = positions[positions.length - 2] ?? -1
      close = positions[positions.length - 1] ?? -1
    }
    if (open === -1 || close === -1) return undefined
    return around
      ? { range: { start: open, end: close + 1 }, linewise: false }
      : { range: { start: open + 1, end: close }, linewise: false }
  }

  function vimBracketObject(
    cursor: number,
    pair: [string, string],
    count: number,
    around: boolean,
  ): VimResolved | undefined {
    const [open, close] = pair
    const text = input.plainText
    let openIndex = -1
    if (text[cursor] === open) {
      openIndex = cursor
    } else {
      let depth = 0
      for (let index = text[cursor] === close ? cursor - 1 : cursor; index >= 0; index--) {
        if (text[index] === close) depth++
        else if (text[index] === open) {
          if (depth === 0) {
            openIndex = index
            break
          }
          depth--
        }
      }
    }
    if (openIndex === -1) return undefined

    const findClose = (start: number) => {
      let depth = 0
      for (let index = start + 1; index < text.length; index++) {
        if (text[index] === open) depth++
        else if (text[index] === close) {
          if (depth === 0) return index
          depth--
        }
      }
      return -1
    }

    let closeIndex = findClose(openIndex)
    if (closeIndex === -1) return undefined

    for (let level = 1; level < count; level++) {
      let depth = 0
      let parent = -1
      for (let index = openIndex - 1; index >= 0; index--) {
        if (text[index] === close) depth++
        else if (text[index] === open) {
          if (depth === 0) {
            parent = index
            break
          }
          depth--
        }
      }
      if (parent === -1) break
      const parentClose = findClose(parent)
      if (parentClose === -1) break
      openIndex = parent
      closeIndex = parentClose
    }

    return around
      ? { range: { start: openIndex, end: closeIndex + 1 }, linewise: false }
      : { range: { start: openIndex + 1, end: closeIndex }, linewise: false }
  }

  function vimParagraphObject(cursor: number, count: number, around: boolean): VimResolved {
    const text = input.plainText
    const starts = vimRowStarts()
    const lastRow = starts.length - 1
    const lineText = (row: number) =>
      text.slice(starts[row] ?? 0, row + 1 < starts.length ? (starts[row + 1] ?? text.length) - 1 : text.length)
    const blank = (row: number) => lineText(row).trim() === ""
    let first = vimRow(cursor)
    while (first > 0 && !blank(first - 1)) first--
    let last = vimRow(cursor)
    while (last + 1 <= lastRow && !blank(last + 1)) last++
    for (let step = 1; step < count; step++) {
      let next = last + 1
      while (next <= lastRow && blank(next)) next++
      if (next > lastRow) break
      last = next
      while (last + 1 <= lastRow && !blank(last + 1)) last++
    }
    let start = starts[first] ?? 0
    let end = last + 1 < starts.length ? (starts[last + 1] ?? text.length) : text.length
    if (around) {
      const before = end
      let next = last + 1
      while (next <= lastRow && blank(next)) {
        end = next + 1 < starts.length ? (starts[next + 1] ?? text.length) : text.length
        next++
      }
      if (end === before) {
        while (first > 0 && blank(first - 1)) {
          first--
          start = starts[first] ?? 0
        }
      }
    }
    return { range: { start, end }, linewise: true }
  }

  function vimObjectRange(around: boolean, char: string, count: number): VimResolved | undefined {
    const cursor = vimCaret()
    if (char === "w") return vimWordObject(cursor, count || 1, around)
    if (char === "p") return vimParagraphObject(cursor, count || 1, around)
    if (char === '"' || char === "'" || char === "`") return vimQuoteObject(cursor, char, around)
    const pair = VIM_BRACKETS[char]
    if (pair) return vimBracketObject(cursor, pair, count || 1, around)
    return undefined
  }

  function vimResolveSpec(spec: VimMotionSpec, count: number): VimResolved | undefined {
    if (spec.type === "object") return vimObjectRange(spec.around, spec.char, count || 1)
    if (
      spec.key === "S" ||
      spec.key === "d" ||
      spec.key === "c" ||
      spec.key === "y" ||
      spec.key === ">" ||
      spec.key === "<"
    )
      return vimDoubledRange(count || 1)
    return vimMotionRange(spec.key, count)
  }

  function vimEnterInsert(change?: VimOperatorChange) {
    vimInsertOrigin = vimCaret()
    vimInsertOperator = change
    setVimMode("insert")
    setVimPending(undefined)
    setVimCount(0)
  }

  function vimLeaveInsert() {
    const origin = vimInsertOrigin
    vimInsertOrigin = undefined
    const operator = vimInsertOperator
    vimInsertOperator = undefined
    if (origin === undefined) return
    const text = input.plainText.slice(origin, vimCaret())
    if (operator) setVimLastChange({ ...operator, insert: text })
    else if (text) setVimLastChange({ kind: "insert", text })
  }

  function vimApplyResolved(
    op: VimOperator,
    resolved: VimResolved,
    motion: VimMotionSpec,
    count: number,
    insert?: string,
  ) {
    const { range, linewise } = resolved
    if (op === "y") {
      setVimRegister({ text: input.plainText.slice(range.start, range.end), linewise })
      vimSetCaret(range.start)
      return
    }
    if (op === "d" || op === "c") {
      setVimRegister({ text: input.plainText.slice(range.start, range.end), linewise })
      vimDeleteRange(range.start, range.end)
      if (op === "c") {
        const change: VimOperatorChange = { kind: "operator", op, count, motion }
        if (insert !== undefined) {
          input.insertText(insert)
          vimSetCaret(range.start + insert.length)
          setVimLastChange({ ...change, insert })
        } else {
          vimEnterInsert(change)
        }
      } else {
        setVimLastChange({ kind: "operator", op, count, motion })
      }
      return
    }
    if (op === ">") {
      vimIndentRange(range, true)
      setVimLastChange({ kind: "operator", op, count, motion })
      return
    }
    if (op === "<") {
      vimIndentRange(range, false)
      setVimLastChange({ kind: "operator", op, count, motion })
      return
    }
    vimToggleRange(range)
    vimSetCaret(range.start)
    setVimLastChange({ kind: "operator", op, count, motion })
  }

  function vimExecute(op: VimOperator, spec: VimMotionSpec, count: number, insert?: string) {
    // Vim's `cw`/`cW` stop at the end of the word instead of swallowing the
    // trailing whitespace, unless the cursor starts on whitespace.
    const changeWord = op === "c" && spec.type === "motion" && (spec.key === "w" || spec.key === "W")
    const resolved = changeWord
      ? vimMotionRange(vimIsSpace(input.plainText[vimCaret()]) ? spec.key : spec.key === "w" ? "e" : "E", count)
      : vimResolveSpec(spec, count)
    if (resolved) vimApplyResolved(op, resolved, spec, count, insert)
    setVimCount(0)
  }

  function vimApplyObject(op: VimOperator, around: boolean, char: string, count: number) {
    const resolved = vimObjectRange(around, char, count || 1)
    if (resolved) vimApplyResolved(op, resolved, { type: "object", around, char }, count)
    setVimCount(0)
  }

  function vimSyncSelection() {
    if (vimMode() !== "visual") {
      input.clearSelection()
      return
    }
    const anchor = vimVisualAnchor()
    const cursor = vimCaret()
    if (vimVisualKind() === "line") {
      input.setSelectionInclusive(
        vimCell(vimLineStart(Math.min(anchor, cursor))),
        vimCell(vimLineEnd(Math.max(anchor, cursor))),
      )
      return
    }
    input.setSelectionInclusive(vimCell(Math.min(anchor, cursor)), vimCell(Math.max(anchor, cursor)))
  }

  function vimVisualResolved(): VimResolved {
    const anchor = vimVisualAnchor()
    const cursor = vimCaret()
    if (vimVisualKind() === "line") {
      return { range: vimLinewiseLineRange(vimRow(anchor), vimRow(cursor)), linewise: true }
    }
    return { range: { start: Math.min(anchor, cursor), end: Math.max(anchor, cursor) + 1 }, linewise: false }
  }

  function vimExitVisual() {
    setVimLastVisual({ anchor: vimVisualAnchor(), cursor: vimCaret(), kind: vimVisualKind() })
    setVimMode("normal")
    input.clearSelection()
    setVimPending(undefined)
    setVimCount(0)
  }

  function vimApplyVisual(op: VimOperator) {
    const resolved = vimVisualResolved()
    setVimLastVisual({ anchor: vimVisualAnchor(), cursor: vimCaret(), kind: vimVisualKind() })
    input.clearSelection()
    setVimMode("normal")
    setVimPending(undefined)
    setVimCount(0)
    vimApplyResolved(op, resolved, { type: "motion", key: "v" }, 1)
  }

  function vimPasteVisual() {
    const resolved = vimVisualResolved()
    const register = vimRegister()
    setVimLastVisual({ anchor: vimVisualAnchor(), cursor: vimCaret(), kind: vimVisualKind() })
    input.clearSelection()
    setVimMode("normal")
    setVimPending(undefined)
    setVimCount(0)
    if (!register.text) return
    vimDeleteRange(resolved.range.start, resolved.range.end)
    input.insertText(register.text)
    vimSetCaret(resolved.range.start + register.text.length - 1)
  }

  function vimRestoreVisual() {
    const last = vimLastVisual()
    if (!last) return
    setVimVisualKind(last.kind)
    setVimVisualAnchor(last.anchor)
    setVimMode("visual")
    vimSetCaret(last.cursor)
    vimSyncSelection()
  }

  function vimEnterVisual(kind: "char" | "line") {
    setVimVisualKind(kind)
    setVimVisualAnchor(vimCaret())
    setVimMode("visual")
    setVimPending(undefined)
    setVimCount(0)
    vimSyncSelection()
  }

  function vimGotoLine(line: number) {
    const starts = vimRowStarts()
    vimSetCaret(starts[Math.min(line, starts.length - 1)] ?? 0)
  }

  function vimFlipFind(find: VimFindKind): VimFindKind {
    if (find === "f") return "F"
    if (find === "F") return "f"
    if (find === "t") return "T"
    return "t"
  }

  function vimCombineCount(first: number, second: number) {
    const total = (first || 1) * (second || 1)
    return first > 0 || second > 0 ? total : 0
  }

  function vimSimple(key: string, count: number) {
    const times = count || 1
    if (key === "x") {
      vimRepeat(times, () => input.deleteChar())
      return
    }
    if (key === "~") {
      const cursor = vimCaret()
      const end = Math.min(vimLineEnd(cursor), cursor + times)
      if (end <= cursor) return
      vimToggleRange({ start: cursor, end })
      vimSetCaret(Math.min(end, vimLineEnd(cursor)))
      return
    }
    if (key === "J") {
      vimJoinLines(times)
      return
    }
    if (key === "p" || key === "P") {
      vimPaste(key === "p", times)
    }
  }

  function vimDot() {
    const change = vimLastChange()
    if (!change) return
    if (change.kind === "insert") {
      if (!change.text) return
      const at = vimCaret()
      input.insertText(change.text)
      vimSetCaret(at + change.text.length)
      return
    }
    if (change.kind === "replace") {
      vimReplaceChar(change.char, change.count)
      return
    }
    if (change.kind === "simple") {
      vimSimple(change.key, change.count)
      return
    }
    vimExecute(change.op, change.motion, change.count, change.insert)
  }

  // Normal and visual mode own every unmodified key so nothing types into the
  // prompt. Modified keys still reach the keymap, and structural keys such as
  // arrows, Home/End and paging keep their existing bindings.
  function takeCount() {
    const count = vimCount()
    setVimCount(0)
    return count
  }

  function vimKey(event: KeyEvent): boolean {
    if (!vimEnabled()) return false
    if (disabled() || store.mode === "shell" || auto()?.visible) return false
    if (!input || input.isDestroyed || !input.focused) return false
    if (leader()) return false
    if (event.ctrl || event.meta || event.super || event.hyper) return false
    if (vimMode() === "normal") return vimNormalKey(event)
    if (vimMode() === "visual") return vimVisualKey(event)
    return false
  }

  // Shared cursor motions. `visual` makes j/k move by line instead of history.
  function vimMove(key: string, times: number, visual: boolean) {
    switch (key) {
      case "h":
        vimRepeat(times, () => input.moveCursorLeft())
        return true
      case "l":
        vimRepeat(times, () => input.moveCursorRight())
        return true
      case "j":
        if (visual) vimRepeat(times, () => input.moveCursorDown())
        else vimHistory(1, times)
        return true
      case "k":
        if (visual) vimRepeat(times, () => input.moveCursorUp())
        else vimHistory(-1, times)
        return true
      case "w":
        vimRepeat(times, () => input.moveWordForward())
        return true
      case "W":
        vimSetCaret(vimWordForwardOffset(vimCaret(), times))
        return true
      case "b":
        vimRepeat(times, () => input.moveWordBackward())
        return true
      case "B":
        vimSetCaret(vimWordBackwardOffset(vimCaret(), times))
        return true
      case "e":
      case "E":
        vimSetCaret(vimWordEndOffset(vimCaret(), times))
        return true
      case "0":
        input.gotoLineHome()
        return true
      case "$":
        input.gotoLineEnd()
        return true
      case "^":
        vimFirstNonBlank()
        return true
      default:
        return false
    }
  }

  function vimNormalKey(event: KeyEvent): boolean {
    const pending = vimPending()

    // Let the keymap clear a pending sequence and keep the existing double-Escape
    // interrupt behavior; an idle Escape simply stays in normal mode.
    if (event.name === "escape") {
      setVimPending(undefined)
      setVimCount(0)
      return false
    }
    if (event.name === "return") {
      setVimPending(undefined)
      // A plain Enter still submits; an inserted newline is suppressed.
      return event.shift
    }
    if (event.name === "backspace" || event.name === "delete") {
      setVimPending(undefined)
      return true
    }
    const key = event.name === "space" ? " " : event.sequence.length === 1 ? event.sequence : undefined
    if (key === undefined) return false

    if (pending?.kind === "find") {
      setVimPending(undefined)
      vimApplyFind(pending.op, pending.find, key, pending.count)
      return true
    }
    if (pending?.kind === "replace") {
      setVimPending(undefined)
      vimReplaceChar(key, pending.count)
      return true
    }
    if (pending?.kind === "g") {
      setVimPending(undefined)
      const count = takeCount()
      if (key === "g") {
        if (pending.op)
          vimExecute(pending.op, { type: "motion", key: "gg" }, vimCombineCount(pending.count ?? 0, count))
        else vimGotoLine(count ? count - 1 : 0)
      } else if (key === "v" && !pending.op) {
        vimRestoreVisual()
      }
      return true
    }
    if (pending?.kind === "textobject") {
      setVimPending(undefined)
      vimApplyObject(pending.op, pending.around, key, pending.count)
      return true
    }

    if (/^[1-9]$/.test(key) || (key === "0" && vimCount() > 0)) {
      setVimCount(vimCount() * 10 + Number(key))
      return true
    }

    if (pending?.kind === "operator") {
      if (key === "i" || key === "a") {
        setVimPending({
          kind: "textobject",
          op: pending.op,
          count: vimCombineCount(pending.count, takeCount()),
          around: key === "a",
        })
        return true
      }
      if (key === "t" || key === "f" || key === "T" || key === "F") {
        setVimPending({ kind: "find", op: pending.op, count: vimCombineCount(pending.count, takeCount()), find: key })
        return true
      }
      if (key === "g") {
        setVimPending({ kind: "g", op: pending.op, count: vimCombineCount(pending.count, takeCount()) })
        return true
      }
      setVimPending(undefined)
      vimExecute(pending.op, { type: "motion", key }, vimCombineCount(pending.count, takeCount()))
      return true
    }

    const count = vimCount()
    const times = count || 1

    if (vimMove(key, times, false)) {
      setVimCount(0)
      return true
    }

    switch (key) {
      case "g":
        setVimPending({ kind: "g" })
        return true
      case "G":
        if (count) vimGotoLine(count - 1)
        else input.gotoBufferEnd()
        setVimCount(0)
        return true
      case "d":
        setVimPending({ kind: "operator", op: "d", count })
        setVimCount(0)
        return true
      case "c":
        setVimPending({ kind: "operator", op: "c", count })
        setVimCount(0)
        return true
      case "y":
        setVimPending({ kind: "operator", op: "y", count })
        setVimCount(0)
        return true
      case ">":
        setVimPending({ kind: "operator", op: ">", count })
        setVimCount(0)
        return true
      case "<":
        setVimPending({ kind: "operator", op: "<", count })
        setVimCount(0)
        return true
      case "t":
      case "f":
      case "T":
      case "F":
        setVimPending({ kind: "find", count, find: key })
        setVimCount(0)
        return true
      case "r":
        setVimPending({ kind: "replace", count: times })
        setVimCount(0)
        return true
      case "s":
        vimExecute("c", { type: "motion", key: "s" }, times)
        return true
      case "S":
        vimExecute("c", { type: "motion", key: "S" }, times)
        return true
      case "C":
        vimExecute("c", { type: "motion", key: "$" }, times)
        return true
      case "D":
        vimExecute("d", { type: "motion", key: "$" }, times)
        return true
      case "x":
        vimSimple("x", times)
        setVimLastChange({ kind: "simple", key: "x", count: times })
        setVimCount(0)
        return true
      case "~":
        vimSimple("~", times)
        setVimLastChange({ kind: "simple", key: "~", count: times })
        setVimCount(0)
        return true
      case "J":
        vimSimple("J", times)
        setVimLastChange({ kind: "simple", key: "J", count: times })
        setVimCount(0)
        return true
      case "p":
        vimSimple("p", times)
        setVimLastChange({ kind: "simple", key: "p", count: times })
        setVimCount(0)
        return true
      case "P":
        vimSimple("P", times)
        setVimLastChange({ kind: "simple", key: "P", count: times })
        setVimCount(0)
        return true
      case "u":
        vimRepeat(times, () => input.undo())
        setVimCount(0)
        return true
      case ";": {
        const last = vimLastFind()
        if (last) vimApplyFind(undefined, last.find, last.char, times)
        setVimCount(0)
        return true
      }
      case ",": {
        const last = vimLastFind()
        if (last) vimApplyFind(undefined, vimFlipFind(last.find), last.char, times)
        setVimCount(0)
        return true
      }
      case ".":
        vimDot()
        setVimCount(0)
        return true
      case "i":
        vimEnterInsert()
        return true
      case "a":
        input.moveCursorRight()
        vimEnterInsert()
        return true
      case "A":
        input.gotoLineEnd()
        vimEnterInsert()
        return true
      case "I":
        vimFirstNonBlank()
        vimEnterInsert()
        return true
      case "o":
        input.gotoLineEnd()
        input.newLine()
        vimEnterInsert()
        return true
      case "O": {
        const origin = vimLineStart(vimCaret())
        vimSetCaret(origin)
        input.newLine()
        vimSetCaret(origin)
        vimEnterInsert()
        return true
      }
      case "v":
        vimEnterVisual("char")
        return true
      case "V":
        vimEnterVisual("line")
        return true
      default:
        return true
    }
  }

  function vimVisualKey(event: KeyEvent): boolean {
    const pending = vimPending()

    if (event.name === "escape") {
      setVimPending(undefined)
      setVimCount(0)
      vimExitVisual()
      return true
    }
    if (event.name === "return") return event.shift
    if (event.name === "backspace" || event.name === "delete") return false
    const key = event.name === "space" ? " " : event.sequence.length === 1 ? event.sequence : undefined
    if (key === undefined) return false

    if (pending?.kind === "find") {
      setVimPending(undefined)
      vimApplyFind(undefined, pending.find, key, pending.count)
      vimSyncSelection()
      return true
    }
    if (pending?.kind === "g") {
      setVimPending(undefined)
      const count = takeCount()
      if (key === "g") vimSetCaret(count ? (vimRowStarts()[count - 1] ?? 0) : 0)
      vimSyncSelection()
      return true
    }

    if (/^[1-9]$/.test(key) || (key === "0" && vimCount() > 0)) {
      setVimCount(vimCount() * 10 + Number(key))
      return true
    }

    const count = vimCount()
    const times = count || 1

    if (key === "g") {
      setVimPending({ kind: "g" })
      return true
    }

    if (key === "o") {
      const anchor = vimVisualAnchor()
      setVimVisualAnchor(vimCaret())
      vimSetCaret(anchor)
      setVimCount(0)
      vimSyncSelection()
      return true
    }

    if (vimMove(key, times, true)) {
      setVimCount(0)
      vimSyncSelection()
      return true
    }

    switch (key) {
      case "G":
        vimSetCaret(
          count ? (vimRowStarts()[Math.min(count - 1, vimRowStarts().length - 1)] ?? 0) : input.plainText.length,
        )
        setVimCount(0)
        vimSyncSelection()
        return true
      case "t":
      case "f":
      case "T":
      case "F":
        setVimPending({ kind: "find", count, find: key })
        setVimCount(0)
        return true
      case ";": {
        const last = vimLastFind()
        if (last) vimApplyFind(undefined, last.find, last.char, times)
        setVimCount(0)
        vimSyncSelection()
        return true
      }
      case ",": {
        const last = vimLastFind()
        if (last) vimApplyFind(undefined, vimFlipFind(last.find), last.char, times)
        setVimCount(0)
        vimSyncSelection()
        return true
      }
      case "d":
      case "x":
        vimApplyVisual("d")
        return true
      case "c":
        vimApplyVisual("c")
        return true
      case "y":
        vimApplyVisual("y")
        return true
      case ">":
        vimApplyVisual(">")
        return true
      case "<":
        vimApplyVisual("<")
        return true
      case "~":
        vimApplyVisual("~")
        return true
      case "p":
        vimPasteVisual()
        return true
      case "v":
      case "V":
        vimExitVisual()
        return true
      default:
        return true
    }
  }

  onCleanup(
    keymap.intercept(
      "key",
      (context) => {
        if (vimKey(context.event)) {
          context.consume({ preventDefault: true, stopPropagation: true })
        }
      },
      { priority: 1000 },
    ),
  )

  async function submit(delivery: SessionInbox.Delivery = "steer") {
    if (disabled()) return false
    // Prevent overlapping invocations (e.g. a double-pressed Enter, or the
    // input's native onSubmit racing another dispatch). Without this guard,
    // a second call slips past the empty-input check before the first call
    // clears `store.prompt.text`, then awaits its own `session.create` and
    // ultimately reads the now-empty store — sending a phantom empty prompt
    // to a freshly created session.
    if (submitting) return false
    submitting = true
    try {
      return await submitInner(delivery)
    } finally {
      submitting = false
    }
  }

  async function submitInner(delivery: SessionInbox.Delivery) {
    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.text) {
      setStore("prompt", "text", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (move.creating()) return false
    if (auto()?.visible) return false
    const trimmed = store.prompt.text.trim()
    if (!trimmed && (!props.sessionID || store.mode === "shell" || delivery === "queue"))
      return delivery === "steer" ? (await props.onEmptySubmit?.()) === true : false
    const exitWord = trimmed === "exit" || trimmed === "quit" || trimmed === ":q"
    const inputText = expandTrackedPastedText(
      store.prompt.text,
      input.extmarks.getAllForTypeId(promptPartTypeId).flatMap((extmark) => {
        const ref = store.extmarkToPart.get(extmark.id)
        if (ref?.type !== "pasted") return []
        const part = store.prompt.pasted[ref.index]
        if (!part) return []
        return [{ start: extmark.start, end: extmark.end, text: part.text }]
      }),
    )
    const slash = argumentSlash(inputText, keymapCommands())
    if (delivery === "queue" && (store.mode === "shell" || exitWord || slash)) {
      toast.show({ message: "This prompt cannot be queued", variant: "warning" })
      return false
    }
    if (exitWord) {
      void exit()
      return true
    }
    if (slash) {
      clearPrompt()
      await slash.command.run(slash.input)
      return true
    }
    const slashHead = parseSlashHead(inputText, /\s/)
    const isCommand =
      slashHead !== undefined &&
      (data.location.command.list(currentLocation.ref) ?? []).some((command) => command.name === slashHead.name)
    const editorSelection = editorContext()
    const pendingEditorSelection = editorSelection && editor.labelState() === "pending" ? editorSelection : undefined
    if (delivery === "queue" && pendingEditorSelection) {
      toast.show({ message: "Editor context cannot be queued", variant: "warning" })
      return false
    }
    const agent = local.agent.current()
    if (!agent) return false
    const selection = local.model.selection()
    if (!selection) {
      void promptModelWarning()
      return false
    }
    const usesModel = !props.sessionID || store.mode !== "shell"
    if (usesModel && !local.model.available(selection)) {
      toast.show({
        title: "Model unavailable",
        message: `${selection.providerID}/${selection.modelID} is not available in this session's location`,
        variant: "warning",
      })
      return false
    }

    // Snapshot the composer and clear it synchronously, before the first await.
    // Everything below reads the snapshot: text typed while a request is in
    // flight lands in the already-empty composer and survives, and prompt
    // history records exactly what was submitted instead of the live store
    // (which may have absorbed mid-flight typing). Failure paths restore the
    // snapshot unless the user has started typing something new.
    const currentMode = store.mode
    const entry = { ...store.prompt, mode: currentMode }
    if (trimmed) {
      resetComposer()
      props.onSubmit?.()
    }
    const restoreEntry = () => {
      if (disposed || input.isDestroyed || input.plainText !== "") return
      input.setText(entry.text)
      setStore("prompt", entry)
      setStore("mode", entry.mode ?? "normal")
      restoreExtmarksFromPrompt(entry)
      input.cursorOffset = entry.text.length
    }
    const fail = (title: string, error: unknown) => {
      toast.show({ title, message: errorMessage(error), variant: "error" })
      restoreEntry()
    }
    const attempt = async (title: string, run: () => Promise<unknown>) => {
      return run().then(
        () => true,
        (error: unknown) => {
          fail(title, error)
          return false
        },
      )
    }

    const variant = selection.variant
    let sessionID = props.sessionID
    let session = sessionID ? data.session.get(sessionID) : undefined
    let finishMoveProgress = false
    // New-session sends wait for creation and environment setup.
    let newSession: { gate: Promise<unknown>; recover: (error: unknown) => void } | undefined
    if (sessionID == null) {
      const directory = await move.getDirectory()
      if (move.pending() && !directory) {
        restoreEntry()
        return false
      }
      finishMoveProgress = Boolean(move.progress())
      // The location context is where the next session is created: seeded by the home
      // route (launch cwd, inherited session location, or picked project) and updated
      // by /cd before a session exists.
      const location = currentLocation.ref ?? data.location.default()

      // Optimistic create: the data layer mints the ID client-side and admits
      // a local session record synchronously, so the navigation below happens
      // immediately — enter feels sent even while the create round-trip is in
      // flight. Sends against the new session gate on the request.
      const newSessionID = args.takeNewSessionID()
      const created = data.session.create({
        id: newSessionID,
        location: directory ? { directory } : location,
        agent: agent.id,
        model: {
          providerID: selection.providerID,
          id: selection.modelID,
          variant,
        },
      })
      if (newSessionID !== undefined) created.request.catch(() => args.restoreNewSessionID(newSessionID))
      sessionID = created.id
      session = data.session.get(created.id)
      newSession = {
        gate: created.request.then(async (info) => {
          if (terminalEnvironment.variables !== undefined) {
            await client.api.session.environment({ sessionID: created.id, variables: terminalEnvironment.variables })
          }
        }),
        recover: (error) => {
          toast.show({
            title: data.session.get(created.id) ? "Failed to set up session" : "Creating a session failed",
            message: errorMessage(error),
            variant: "error",
          })
          const active =
            route.data.type === "session" && route.data.sessionID === created.id ? promptRef.current : undefined
          const current = active?.current
          const draft = current?.text
            ? { prompt: { ...unwrap(current) }, cursor: current.text.length }
            : (takeDraft(created.id) ?? { prompt: entry, cursor: entry.text.length })
          saveDraft(undefined, draft)
          active?.reset()
          if (sessionTabs.enabled()) {
            sessionTabs.close(created.id)
          } else if (route.data.type === "session" && route.data.sessionID === created.id) {
            route.navigate({ type: "home" })
          }
        },
      }
    }

    const target = sessionID
    const prepareAgent = async () => {
      if (!session) {
        await data.session.sync(target)
        session = data.session.get(target)
      }
      if (session?.agent !== agent.id) {
        await client.api.session.switchAgent({ sessionID: target, agent: agent.id })
      }
    }
    const commitModel = () => {
      const model = { providerID: selection.providerID, id: selection.modelID, variant }
      const cancelCommit = local.model.trackSessionCommit(target, model, agent.id)
      return client.api.session.switchModel({ sessionID: target, model }).catch((error) => {
        cancelCommit()
        throw new Error(`Failed to switch model: ${errorMessage(error)}`, { cause: error })
      })
    }
    const commitSelection = async () => {
      await prepareAgent()
      await commitModel()
    }
    if (!trimmed) {
      // Blank Enter in an existing session commits the composer's agent and
      // model selection, then hands off to the route (queued prompt promotion).
      await attempt("Failed to prepare session", async () => {
        await commitSelection()
        await props.onEmptySubmit?.()
      })
      return true
    }
    history.append(entry)
    if (currentMode === "shell") {
      move.startSubmit()
      const send = () => client.api.session.shell({ sessionID: target, command: inputText })
      void (newSession ? newSession.gate.then(send).catch(newSession.recover) : send())
      setStore("mode", "normal")
    } else if (slashHead && isCommand) {
      const send = async () => {
        // Commands inherit the composer selection; command-specific overrides
        // remain server-owned and run after this preparation.
        await commitSelection()
        return client.api.session.command({
          sessionID: target,
          name: slashHead.name,
          text: slashHead.arguments,
          files: entry.files,
          agents: entry.agents,
          skills: entry.skills?.length ? entry.skills : undefined,
          delivery,
        })
      }
      void (newSession ? newSession.gate.then(send) : send()).catch((error) =>
        newSession ? newSession.recover(error) : fail("Failed to run command", error),
      )
    } else {
      move.startSubmit()
      if (!(await attempt("Failed to prepare session", prepareAgent))) return true
      // Revert must settle before optimistic admission: its committed echo
      // splices every local row at or after the boundary, which would include
      // a freshly admitted prompt.
      if (
        session?.revert &&
        !(await attempt("Failed to commit revert", () => client.api.session.revert.commit({ sessionID: target })))
      )
        return false
      if (pendingEditorSelection) {
        // Keep editor context hidden while admitting it before the corresponding user prompt.
        const send = () =>
          client.api.session.synthetic({
            sessionID: target,
            text: formatEditorContext(pendingEditorSelection),
            resume: false,
          })
        // Fold into the setup gate so the context still admits before the
        // user prompt once the session exists.
        if (newSession) newSession.gate = newSession.gate.then(send)
        else if (!(await attempt("Failed to send editor context", send))) return false
      }
      // The data layer admits optimistically: the prompt renders immediately
      // and rolls back if the server rejects it, so submission does not wait
      // on the network. On rejection the row is already rolled back; restore
      // the composer unless the user has started typing something new.
      data.session
        .prompt({
          sessionID: target,
          text: inputText,
          files: entry.files,
          agents: entry.agents,
          skills: entry.skills?.length ? entry.skills : undefined,
          delivery,
          gate: newSession?.gate,
          // Commit the captured selection after earlier admissions, including
          // compaction setup. Cached state may still precede their SSE echoes;
          // the server makes an unchanged selection a no-op.
          prepare: commitModel,
        })
        .catch((error) => (newSession ? newSession.recover(error) : fail("Failed to send prompt", error)))
      if (pendingEditorSelection) editor.markSelectionSent()
    }

    // Optimistic admission puts the message in the store synchronously, so
    // the session view renders it on arrival.
    if (!props.sessionID) {
      if (pendingEditorSelection) editor.preserveSelectionFromNewSession()
      // Text typed while session creation was in flight lives in this (home)
      // prompt, which unmounts on navigation and would stash it under the
      // home key. Re-stash it under the new session so that composer restores
      // it, and clear it here so onCleanup does not also stash it for home.
      if (!disposed && !input.isDestroyed && store.prompt.text) {
        // Copy before clearing: unwrap returns the live store target, and the
        // resetComposer store write merges into that same object.
        saveDraft(sessionID, { prompt: { ...unwrap(store.prompt) }, cursor: input.cursorOffset })
        resetComposer()
      }
      route.navigate({
        type: "session",
        sessionID,
      })
    }
    if (finishMoveProgress) move.finishSubmit()
    return true
  }

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + promptOffsetWidth(virtualText)

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const index = draft.prompt.pasted.length
        draft.prompt.pasted.push({
          text,
          source: { start: extmarkStart, end: extmarkEnd, text: virtualText },
        })
        draft.extmarkToPart.set(extmarkId, { type: "pasted", index })
      }),
    )
  }

  function expandPastedText(extmarkId: number) {
    const extmark = input.extmarks.get(extmarkId)
    const ref = store.extmarkToPart.get(extmarkId)
    if (!extmark || ref?.type !== "pasted") return false
    const part = store.prompt.pasted[ref.index]
    if (!part) return false

    input.extmarks.delete(extmarkId)
    input.setSelection(extmark.start, extmark.end)
    input.insertText(part.text)
    return true
  }

  async function pasteInputText(text: string, changed: () => boolean) {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const pastedContent = normalizedText.trim()
    const attachments = await resolvePastedAttachments(pastedContent, terminalEnvironment.platform)
    if (changed()) return
    if (attachments) {
      attachments.forEach((attachment) => {
        if (attachment.type === "text") {
          pasteText(attachment.content, `[SVG: ${attachment.filename || "image"}]`)
          return
        }
        pasteAttachment(attachment)
      })
      return
    }

    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if ((lineCount >= 3 || pastedContent.length > 150) && config.prompt?.paste !== "full") {
      const extmark = input.extmarks.getAllForTypeId(promptPartTypeId).find((extmark) => {
        const ref = store.extmarkToPart.get(extmark.id)
        return (
          (extmark.end === input.cursorOffset || extmark.end + 1 === input.cursorOffset) &&
          ref?.type === "pasted" &&
          store.prompt.pasted[ref.index]?.text === pastedContent
        )
      })
      if (extmark && expandPastedText(extmark.id)) return
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)

    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      renderer.requestRender()
    }, 0)
  }

  function pasteAttachment(file: { filename?: string; uri: string }) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const virtualText = promptAttachmentLabel(store.prompt.files, { uri: file.uri, name: file.filename })
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: NonNullable<PromptInfo["files"]>[number] = {
      uri: file.uri,
      name: file.filename,
      mention: {
        start: extmarkStart,
        end: extmarkEnd,
        text: virtualText,
      },
    }
    setStore(
      produce((draft) => {
        const files = (draft.prompt.files ??= [])
        const index = files.length
        files.push(part)
        draft.extmarkToPart.set(extmarkId, { type: "file", index })
      }),
    )
  }

  function clearPrompt() {
    if (
      store.prompt.text.trim().length >= DRAFT_RETENTION_MIN_CHARS ||
      store.prompt.pasted.length > 0 ||
      (store.prompt.files?.length ?? 0) > 0 ||
      (store.prompt.agents?.length ?? 0) > 0
    ) {
      history.append({
        ...store.prompt,
        mode: store.mode,
      })
    }
    resetComposer()
  }

  // Keep the last resolved prompt display visible while destination catalogs load;
  // availability and submission still use the live location-scoped catalog.
  const promptDisplay = createMemo<{
    agentLabel: string | undefined
    agentColor: RGBA | undefined
    modelLabel: string
    providerLabel: string
    variant: string | undefined
  }>(
    (previous) => {
      const location = currentLocation.ref ?? data.location.default()
      const sessionLocation = props.sessionID ? data.session.get(props.sessionID)?.location : location
      if (!sessionLocation || locationKey(sessionLocation) !== locationKey(location)) return previous

      const loading = data.location.agent.list(location) === undefined || !local.model.catalogReady
      const error = currentLocation.error
      const failed = error && locationKey(error.location) === locationKey(location)
      if (loading && !failed) return previous

      const agent = local.agent.current()
      const model = local.model.parsed()
      return {
        agentLabel: agent ? Locale.titlecase(agent.id) : undefined,
        agentColor: agent ? local.agent.color(agent.id) : undefined,
        modelLabel: model.model,
        providerLabel: model.provider,
        variant: local.model.variant.current(),
      }
    },
    {
      agentLabel: undefined,
      agentColor: undefined,
      modelLabel: local.model.parsed().model,
      providerLabel: local.model.parsed().provider,
      variant: undefined,
    },
  )
  const highlight = createMemo(() => {
    if (muted()) return theme.border.base
    if (store.mode === "shell") return theme.text.action.primary.selected
    return promptDisplay().agentColor ?? theme.border.base
  })
  const agentLabel = createMemo(() => (store.mode === "shell" ? "Shell" : promptDisplay().agentLabel))
  const animateMetadata = !revealedPromptMetadata.has(local)
  const metadataAnimationsEnabled = () => animationsEnabled() && animateMetadata
  const agentMetaAlpha = createFadeIn(() => !!agentLabel(), metadataAnimationsEnabled)
  const modelMetaAlpha = createFadeIn(
    () => !!promptDisplay().agentLabel && store.mode === "normal",
    metadataAnimationsEnabled,
  )
  const variantMetaAlpha = createFadeIn(
    () => !!promptDisplay().agentLabel && store.mode === "normal" && !!promptDisplay().variant,
    metadataAnimationsEnabled,
  )
  createEffect(() => {
    if (agentLabel()) revealedPromptMetadata.add(local)
  })
  const borderHighlight = createMemo(() => tint(theme.border.base, highlight(), agentMetaAlpha()))
  const footerInput = () => ({
    sessionID: props.sessionID,
    mode: store.mode,
    showDetails: store.interrupt === 0 || dimensions().width >= 80,
  })

  const placeholderText = createMemo(() => {
    const value = (() => {
      if (store.mode === "shell") {
        if (!shell().length) return undefined
        return `Run a command… "${shell()[store.placeholder % shell().length]}"`
      }
      if (!list().length) return undefined
      return `Ask anything… "${list()[store.placeholder % list().length]}"`
    })()
    if (!value) return undefined
    const width = dimensions().width < 44 ? dimensions().width - 5 : Math.min(75, dimensions().width - 4) - 5
    return Locale.takeWidth(value, Math.max(1, width)).trimEnd()
  })
  const footerLocation = createMemo(() => {
    if (!props.sessionID) {
      // No session yet: show where the next session will be created.
      return currentLocation.ref ?? data.location.default()
    }
    if (status() !== "idle") return
    return data.session.get(props.sessionID)?.location
  })
  const locationLabel = createMemo(() => {
    const pending = pendingDirectory()
    const location = pending ? { directory: pending } : footerLocation()
    if (!location) return
    const directory = abbreviateHome(location.directory, paths.home)
    const branch = data.location.vcs.info(location)?.branch.current
    return branch ? `${directory}:${branch}` : directory
  })
  const [locationWidth, setLocationWidth] = createSignal(dimensions().width)
  const locationLabelDisplay = createMemo(() => {
    const label = locationLabel()
    if (!label) return
    return truncateFilePath(label, locationWidth())
  })
  const locationActions = useWorkingDirectoryActions({
    directory: () => footerLocation()?.directory,
    onMove: () => void move.open(),
  })

  const spinnerDef = createMemo(() => {
    const color = promptDisplay().agentColor ?? theme.border.base
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })
  const maxHeight = createMemo(() => Math.max(6, Math.floor(dimensions().height / 3)))

  const promptBg = createMemo(() => theme.decrease(theme.background.raised.base))

  return (
    <>
      <box ref={(r: BoxRenderable) => (anchor = r)} visible={props.visible !== false} width="100%">
        <box
          width="100%"
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={dimensions().width < 44 ? 1 : 2}
            paddingRight={dimensions().width < 44 ? 1 : 2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={promptBg()}
            flexGrow={1}
            width="100%"
          >
            <Show when={config.prompt?.image_preview && visibleImageAttachments().length > 0}>
              <box
                width="100%"
                height={imagePreviewHeight() + 1}
                flexDirection="row"
                flexShrink={0}
                justifyContent="flex-start"
                gap={1}
                paddingBottom={1}
              >
                <For each={visibleImageAttachments()}>
                  {(file, index) => {
                    const [failed, setFailed] = createSignal(false)
                    return (
                      <box
                        width={imagePreviewWidth()}
                        height={imagePreviewHeight()}
                        flexBasis={imagePreviewWidth()}
                        flexShrink={1}
                        onMouseUp={(event: MouseEvent) => {
                          if (event.button !== 0) return
                          event.stopPropagation()
                          openImagePreview(index())
                        }}
                      >
                        <Show
                          when={!failed()}
                          fallback={
                            <box width="100%" height="100%" alignItems="center" justifyContent="center">
                              <text fg={theme.text.muted}>No preview</text>
                            </box>
                          }
                        >
                          <image
                            id={`prompt-image-preview-${index()}`}
                            source={file.uri}
                            fit="cover"
                            protocol="auto"
                            width="100%"
                            height="100%"
                            onError={() => setFailed(true)}
                          />
                        </Show>
                      </box>
                    )
                  }}
                </For>
                <Show when={imageAttachments().length > visibleImageAttachments().length}>
                  <box
                    width={8}
                    height={imagePreviewHeight()}
                    flexBasis={8}
                    flexShrink={1}
                    alignItems="center"
                    justifyContent="center"
                    onMouseUp={(event: MouseEvent) => {
                      if (event.button !== 0) return
                      event.stopPropagation()
                      openImagePreview(visibleImageAttachments().length)
                    }}
                  >
                    <text fg={theme.text.muted} wrapMode="none" truncate>
                      +{imageAttachments().length - visibleImageAttachments().length} more
                    </text>
                  </box>
                </Show>
              </box>
            </Show>
            <textarea
              width="100%"
              placeholder={placeholderText()}
              placeholderColor={theme.text.muted}
              textColor={muted() ? theme.text.muted : theme.text.base}
              focusedTextColor={muted() ? theme.text.muted : theme.text.base}
              minHeight={1}
              maxHeight={maxHeight()}
              cursorStyle={config.cursor}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "text", value)
                auto()?.onInput(value)
                syncExtmarksWithPromptParts()
                setCursorVersion((value) => value + 1)
              }}
              onCursorChange={() => setCursorVersion((value) => value + 1)}
              onKeyDown={(e: { preventDefault(): void }) => {
                if (disabled()) {
                  e.preventDefault()
                  return
                }
              }}
              onSubmit={() => {
                if (disabled()) return
                // IME: double-defer so the last composed character (e.g. Korean
                // hangul) is flushed to plainText before we read it for submission.
                setTimeout(() => setTimeout(() => submit(), 0), 0)
              }}
              onPaste={(event: PasteEvent) => {
                if (disabled()) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (event.bytes.byteLength === 0) {
                  keymap.dispatch("prompt.paste")
                  return
                }

                // Once we cross an async boundary below, the terminal may perform its
                // default paste unless we suppress it first and handle insertion ourselves.
                event.preventDefault()

                void enqueuePaste((changed) => pasteInputText(normalizedText, changed))
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                Object.assign(r, {
                  getClipboardText: (text: string) => expandPastedTextPlaceholders(text, store.prompt.pasted),
                })
                setInputTarget(r)
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.cursorColor = disabled() ? theme.background.raised.base : theme.text.base
                  if (config.cursor) input.cursorStyle = config.cursor
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => {
                if (disabled()) {
                  r.preventDefault()
                  return
                }
                if (r.button !== 0) return
                r.target?.focus()
                const extmark = input.extmarks
                  .getAtOffset(input.cursorOffset)
                  .find((item) => store.extmarkToPart.get(item.id)?.type === "pasted")
                if (!extmark || !expandPastedText(extmark.id)) return
                r.preventDefault()
                r.stopPropagation()
              }}
              focusedBackgroundColor="transparent"
              cursorColor={disabled() ? theme.background.raised.base : theme.text.base}
              syntaxStyle={syntax()}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <PromptMetadataRow
                mode={store.mode}
                vim={
                  vimEnabled() && vimMode() !== "insert" ? (vimMode() === "visual" ? "VISUAL" : "NORMAL") : undefined
                }
                agent={agentLabel()}
                auto={local.permission.mode === "autoaccept"}
                model={promptDisplay().modelLabel}
                provider={promptDisplay().providerLabel}
                variant={promptDisplay().variant}
                muted={!!muted()}
                highlight={highlight()}
                agentAlpha={agentMetaAlpha()}
                modelAlpha={modelMetaAlpha()}
                variantAlpha={variantMetaAlpha()}
              />
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: promptBg().a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={promptBg()}
            customBorderChars={
              promptBg().a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
          <Slot path="prompt.footer" input={footerInput()}>
            <Slot path="prompt.footer.status" input={footerInput()}>
              <box
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
                onSizeChange={function (this: BoxRenderable) {
                  const width = this.width
                  queueMicrotask(() => setLocationWidth(width))
                }}
              >
                <Switch>
                  <Match when={status() === "running"}>
                    <box flexDirection="row" gap={1} flexGrow={1} justifyContent="flex-start">
                      <box marginLeft={1}>
                        <Show when={config.animations ?? true} fallback={<text fg={theme.text.muted}>[⋯]</text>}>
                          <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                        </Show>
                      </box>
                      <PromptInterruptStatus
                        armed={store.interrupt > 0}
                        animations={animationsEnabled()}
                        text={theme.text.base}
                        subdued={theme.text.muted}
                        warning={theme.text.feedback.warning.base}
                        flash={theme.decrease(theme.text.feedback.warning.base, 2)}
                      />
                    </box>
                  </Match>
                  <Match when={move.progress()}>
                    {(progress) => (
                      <box paddingLeft={3} height={1} minHeight={0} flexShrink={1}>
                        <Spinner color={theme.hue.accent[500]}>
                          {progress()}
                          <span style={{ fg: theme.text.muted }}>{".".repeat(move.creatingDots())}</span>
                        </Spinner>
                      </box>
                    )}
                  </Match>
                  <Match when={move.pendingNew()}>
                    <box paddingLeft={3} height={1} minHeight={0} flexShrink={1}>
                      <text fg={theme.hue.accent[500]} wrapMode="none" truncate>
                        (new worktree)
                      </text>
                    </box>
                  </Match>
                  <Match when={true}>
                    <Show when={locationLabelDisplay()} fallback={<text />}>
                      {(location) => (
                        <text
                          id="prompt.footer.location"
                          fg={locationActions.hovered() ? theme.text.base : theme.text.muted}
                          wrapMode="none"
                          truncate
                          flexGrow={1}
                          flexShrink={1}
                          onMouseOver={locationActions.onMouseOver}
                          onMouseOut={locationActions.onMouseOut}
                          onMouseUp={locationActions.onMouseUp}
                        >
                          {location()}
                        </text>
                      )}
                    </Show>
                  </Match>
                </Switch>
              </box>
            </Slot>
            <Slot path="prompt.footer.file" input={footerInput()}>
              <Show when={editorContextLabelState() !== "none" ? editorFileLabelDisplay() : undefined}>
                {(file) => (
                  <text
                    wrapMode="none"
                    truncate
                    flexShrink={1}
                    fg={editorContextLabelState() === "pending" ? theme.hue.accent[500] : theme.text.muted}
                  >
                    {file()}
                  </text>
                )}
              </Show>
            </Slot>
          </Slot>
        </box>
      </box>
      <Autocomplete
        sessionID={props.sessionID}
        argumentAutocomplete={(command) => (command.id === "session.cd" ? "directory" : undefined)}
        directoryOptions={(query): AutocompleteOption[] => {
          if (query !== "") return []
          const projectID =
            (props.sessionID ? data.session.get(props.sessionID)?.projectID : undefined) ??
            data.location.info()?.project.id
          if (!projectID) return []
          return directoryRecents.list(projectID).map((item) => {
            const value = directoryRecentValue(item.directory, paths.home)
            return {
              display: value,
              value,
              description: "recent",
              isDirectory: true,
              path: value,
              absolute: item.directory,
              destructive: {
                id: item.directory,
                confirm: "Press ctrl+d to confirm",
                run: () => directoryRecents.remove(projectID, item.directory),
              },
            }
          })
        }}
        ref={(r) => {
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(part, extmarkId) => {
          setStore("extmarkToPart", (map: Map<number, PromptPartRef>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, part)
            return newMap
          })
        }}
        value={store.prompt.text}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        skillStyleId={skillStyleId}
        hasSkill={(id) => store.prompt.skills?.some((skill) => skill.id === id) ?? false}
        promptPartTypeId={() => promptPartTypeId}
      />
    </>
  )
}
