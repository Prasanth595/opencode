# Port plan: markdown streaming incremental projection (#48432 → V2)

Investigation-only document. No production code is changed by this branch.

## 0. Context

- Upstream repo: `anomalyco/opencode` (`upstream` remote). Working fork: `dcerisano/opencode` (`origin`).
- Target branch: `fix/markdown-stream-incremental-projection`, created from `origin/dev`
  (`d0732eadf883bdc64c0b0ea91e9c4ee0fe51d8c3`, which equals the current `dev`).
- Original PR #48432 (`fix(session-ui): grow markdown live tail in place`) was authored
  against V1 `dev` and **closed** by a maintainer with "port it over and open it for V2".
- Related PR #54427 (`refactor(session-ui): append to the markdown store by path`) is a
  **different layer** (renderer store reconciliation), still open, and is kept separate here.

### Pre-existing work found in the repository

Two local branches already contain a port of #48432:

- `markdown-live-relex` — V1-shaped port (base is an older commit; also adds `.gitignore` entry
  and PR-description files). Not a clean base for V2.
- `v2-markdown-live-relex` — V2-shaped port on a recent `dev`. `git diff dev...v2-markdown-live-relex`
  touches only `markdown-stream.ts` (+50/−13) and `markdown-stream.test.ts` (+31). This is the
  closest existing implementation and should be treated as reference/review input, not silently reused.

The requested branch name `fix/markdown-stream-incremental-projection` did not exist and was created fresh.
Note: this name uses a `fix/` prefix and a slash, which conflicts with the root `AGENTS.md`
branch-naming guidance ("at most three hyphen-separated words, no slashes or type prefixes").
The explicit task name is used; flag if the convention should win.

## 1. Exact source files involved

- `packages/session-ui/src/components/markdown-stream.ts` — **the file to change.**
  Exports `Block`, `Projection`, `stream()`, `project()`. Contains `LIVE_TAIL_MAX` (to add).
- `packages/session-ui/src/components/markdown-stream.test.ts` — unit tests for `stream`/`project`.
- `packages/session-ui/src/components/markdown-projection.ts` — `completedProjection()`,
  `canReusePendingBlock()`. Likely unchanged; `canReusePendingBlock` has `mode`/`raw` reuse semantics.
- `packages/session-ui/src/components/markdown.worker.ts` — worker `projections: Map<key, Projection>`
  and `runProject()`, which is where `project()` is actually invoked per delta.
- `packages/session-ui/src/components/markdown-worker.ts` — main-thread `projectMarkdown(key, text, live)`,
  `disposeMarkdownProjection(key)`, latest-wins queueing.
- `packages/session-ui/src/components/markdown-worker-protocol.ts` — `project` request/response shape.
- `packages/session-ui/src/components/markdown.tsx` — consumer: `createResource` calls `projectMarkdown`,
  builds `RenderedBlock`s, falls back to `fallback()`/`renderCachedMarkdown`.
- `packages/session-ui/src/components/markdown-solid.tsx` — renderer store (`createMarkdownRenderer`),
  the layer PR #54427 targets. Separate concern.
- `packages/session-ui/performance/markdown-lifetime/*` — existing completed-render browser benchmark.

## 2. Current bottleneck and evidence

### The bottleneck

In `markdown-stream.ts`, `stream(text, live)` calls `lexer.lexer(text)` — a full marked lex of the
**entire accumulated message** — on every call (line ~68). `project(previous, text, live)` only avoids
that for a still-open **`code`** tail:

```ts
const tail = previous.blocks.at(-1)
const suffix = text.slice(previous.text.length)
if (!suffix || tail?.mode !== "code" || tail.complete || closesFence(tail.raw, suffix))
  return { text, blocks: stream(text, live) }   // <-- full lex of `text`
return { text, blocks: [...previous.blocks.slice(0, -1), { ...tail, raw: tail.raw + suffix, src: tail.src + suffix }] }
```

Therefore, for **ordinary prose / lists / tables** whose tail block is `mode: "live"`, every streamed
delta re-lexes the whole message. With n deltas over a message that grows to length L this is O(n·L) ≈
O(L²). This is the dominant projection cost the PR removes.

Evidence:

- Current `dev` blob for `markdown-stream.ts` is `4879a09f5022cfaba12b7167e37d804b5e82a84c`; the file has
  no live-tail fast path (verified by reading lines 112–153).
- PR #48432 body: "While streaming, the markdown projection re-parsed the entire accumulated text on
  every delta … Each re-lex is O(length), so a stream of n small deltas costs O(n²)."
- The worker (`markdown.worker.ts`) retains per-key `Projection` state and runs `project()` on each
  request, so the main thread pays only message-passing; the lex cost is on the worker/session-ui side.
- The renderer still re-parses live-block HTML per delta (see #54427/#54428) — a **separate** cost that
  this port does not address.

### How `project()` receives/retains previous state

The main thread sends `{ key, text, live }` — never the previous projection. The worker keeps
`projections: Map<string, Projection>` keyed by the component's unique owner id and passes
`projections.get(key)` as `previous`. `disposeMarkdownProjection(key)` clears it on unmount. Requests
are funnelled through `createLatestWorkerQueue` (latest-wins, older superseded).

### Block representation

`Block = { raw, src, mode: "full" | "live" | "code", language?, complete? }`.

- Completed top-level blocks → `mode: "full"` (`src === raw`, frozen).
- The active tail → `mode: "live"` (`src` is `remend(raw)`, healed) or `mode: "code"`.
- On stream stop (`live === false`), `project` converts the last `live` → `full` and an incomplete
  `code` → `complete: true`.

### Unfinished code handling

If the last lexed token is `code` and `open(code.raw)` reports the fence still open, `stream` emits
`{ mode: "code", src: openCode(code.raw), complete: undefined }`. `closesFence(tail.raw, suffix)` detects a
closing fence arriving across deltas and forces a re-lex so the block becomes `complete`.

### Refs / math / remend interaction

- `refs(text)` short-circuits `stream` to a **single `live` block** whenever `[x]:` reference definitions
  are present, so definitions stay with their uses.
- `markdownMath` is passed to `Marked`, so `$$…$$` display math is one token and never split.
- `heal` = `remend(text, { linkMode: "text-only" })`, applied to every live `src` to fix incomplete
  emphasis/links/inline code.

### Can it be ported directly?

Yes, essentially directly — the V2 `project()` already has the code-tail fast path that the PR keeps,
so the change is additive: insert a `tail.mode === "live"` branch before the code branch. The existing
`v2-markdown-live-relex` branch is proof it applies cleanly. Adaptation is limited to comment wording
(#48432's comment references V1 `sync.tsx` / `#6172` / `#42264`) and reconciling with the
`refs`/boundary concerns below.

### Related PR #54427 (separate layer)

#54427 addresses the **renderer store**, not the projection. In `createMarkdownRenderer.update` it
currently calls `setNodes(reconcile(parseMarkdownNodes(next, nextWords, animate), { key: "key" }))`,
which re-diffs the entire node array per delta (`reconcile` + `unwrap` walk the whole tree; ~5 ms/update
at 3000 words). The PR walks the tail by path and writes only the changed node/children via
`setNodes(...path)`, falling back to `reconcile` when more than the tail changed. It also adds a
streaming test to `markdown-solid.test.tsx` requiring `bun test --conditions=browser`. Keep this out of
the projection change; do not couple them.

## 3. Proposed algorithmic changes

All changes confined to `markdown-stream.ts`:

1. Add a cap constant and a boundary predicate:

   ```ts
   const LIVE_TAIL_MAX = 2048
   function hasBlockBoundary(text: string) {
     return text.includes("\n\n")
   }
   ```

2. In `project()`, before the code branch, grow a `live` tail in place:

   ```ts
   if (!suffix) return previous
   if (tail?.mode === "live") {
     const raw = tail.raw + suffix
     if (raw.length <= LIVE_TAIL_MAX || !hasBlockBoundary(suffix))
       return { text, blocks: [...previous.blocks.slice(0, -1), { ...tail, raw, src: heal(raw) }] }
     return { text, blocks: [...previous.blocks.slice(0, -1), ...stream(raw, true)] }
   }
   if (tail?.mode === "code" && !tail.complete && !closesFence(tail.raw, suffix)) { /* existing code append */ }
   return { text, blocks: stream(text, live) }
   ```

   Key property: the re-lex calls `stream(raw, true)` on the **tail only**, so even the re-lex is bounded
   by the tail, not the whole message. A boundary-less tail (giant paragraph/list/table) keeps growing in
   place and is never re-lexed per delta.

3. Keep the existing code-tail fast path and the non-live finalization path unchanged.

### Threshold

`LIVE_TAIL_MAX = 2048` characters. Re-lex is skipped while the tail is ≤ cap. Above the cap it re-lexes
**only when** the new suffix introduces a blank-line boundary; a boundary-less oversized tail still grows
in place.

### Boundary detection rules

- `hasBlockBoundary(suffix)`: `suffix.includes("\n\n")`.
- Existing, unchanged: `refs(text)` (reference definitions), `open()`/`closesFence()` (fence state),
  `Marked(markdownMath)` lexing for math-safe tokens.

### Re-projection triggers

1. `live === false` and text changed / not a prefix (finalize).
2. Not `live` previous or `!text.startsWith(previous.text)`.
3. Empty suffix → return `previous`.
4. Tail `mode === "live"` exceeds `LIVE_TAIL_MAX` **and** suffix contains `\n\n` → re-lex tail.
5. Tail `mode === "code"` complete, or `closesFence` true → re-lex full text.
6. Any other tail mode → re-lex full text.

## 4. Correctness risks and fallback conditions

1. **Late reference definitions (highest risk).** `stream()` calls `refs(text)` on the *whole* text and, if
   true, collapses everything into one `live` block. The incremental path grows the tail in place and never
   re-checks `refs`, so a `[x]:` definition appended after earlier blocks were frozen will not merge the
   definition with its earlier uses. The re-lex also runs `stream(raw)` on the tail **only**, so it cannot
   see a definition/usage in a frozen sibling. Mitigation options: re-check `refs(suffix)` (and `refs` on the
   accumulated tail) and fall back to `stream(text, true)`; add tests.
2. **Boundaries other than blank lines.** Setext headings, thematic breaks adjacent to text, HTML blocks,
   or a fence opening without a preceding blank line form boundaries that `\n\n` does not detect. Re-lex is
   deferred to the cap. Decide whether to extend the predicate.
3. **A live tail that becomes a code fence.** If a fence starts inside a growing `live` tail, the block stays
   `mode: "live"` (not `mode: "code"`) until a blank line or the cap triggers re-lex, so streaming Shiki
   highlighting does not engage promptly. Consider detecting fence-open in the suffix.
4. **Residual `heal(raw)` cost.** The in-place path recomputes `heal(raw)` (remend) each delta over the whole
   tail. For a boundary-less tail this is O(n) per delta. #48432's benchmark shows this is far cheaper than a
   full lex, but it is not constant; measure and consider bounding.
5. **Renderer still re-parses per delta.** Projection savings do not reduce the DOM/parse cost #54427/#54428
   target; expectations must not conflate the two.
6. **Fallback condition.** `!text.startsWith(previous.text)` (edits, truncation, non-prefix replacement) must
   always fall back to `stream(text, live)` — the existing tests "reprojects non-prefix replacements" and
   "reprojects truncation" protect this.

## 5. Tests to add or adapt

Adapt the three tests from #48432 / `v2-markdown-live-relex` into `markdown-stream.test.ts`:

1. `appends plain text deltas without reprojecting frozen blocks` — assert earlier block object identity
   (`toBe`) is preserved and only the tail grows.
2. `boundedly re-lexes the live tail once it exceeds the cap` — grow 400 × `"para\n\n"`; assert the tail
   stays `live` and some `full` blocks exist.
3. `grows a boundary-less oversized tail in place without splitting` — grow 600 × `"word "`; assert exactly
   one `live` block whose `raw === word.repeat(601)`.

Add new regression tests for the risks above:

- Late reference definition appended after a frozen block (define expected merge behavior).
- Fence opened inside a growing live tail (should it become `code`?).
- Setext heading / thematic break without a preceding blank line.
- Cap-crossing with a blank line re-lexes only the tail and preserves prefix identity.
- Non-prefix / truncation fallbacks still delegate to `stream`.

If PR #54427 is landed alongside, also adapt `markdown-solid.test.tsx` streaming test; it requires
`--conditions=browser`.

## 6. Appropriate benchmark workloads

Micro-benchmark `project()` directly in Bun with small deltas over 6–15 KB fixtures (matching #48432):

- Many short paragraphs (blank-line boundaries each delta).
- One long single paragraph (boundary-less; exercises in-place growth + `heal`).
- Growing list.
- Growing table.
- Open code fence streamed across deltas.
- Reference-definition-heavy text (exercises `refs`).
- Display math with blank lines inside `$$…$$`.

Report total time and per-delta scaling (to demonstrate removal of O(n²)). #48432 baseline numbers:
paragraphs 1399 ms → 20 ms; single 15 KB paragraph 32345 ms → 161 ms; growing list 4467 ms → 60 ms.

Browser-level: `performance/markdown-lifetime` measures **completed** render lifetime, not streaming, so
it is not a drop-in streaming benchmark. Either add a streaming variant or reuse the #54305-style
per-update measurement; document that the projection fix targets worker CPU, not DOM.

## 7. Actual package test commands

From `packages/session-ui` (tests cannot run from repo root):

- Unit tests: `bun test src`
- Browser-conditions tests (needed for `markdown-solid.test.tsx`): `bun test --conditions=browser src`
- Typecheck: `bun typecheck` (`tsgo -b`)
- Component tests (Playwright): `bun test:components`
- Root lint+typecheck: `bun run check` (from repo root)

## 8. Questions to resolve before implementation

1. Branch naming: keep the requested `fix/markdown-stream-incremental-projection`, or follow the root
   `AGENTS.md` convention (no slash/type prefix)?
2. Reuse/rebase the existing `v2-markdown-live-relex` port, or re-implement cleanly on this branch? (Both
   are the same change.)
3. How should a **late reference definition** be handled — re-check `refs` on the suffix and full-text
   fallback, or accept the current behavior?
4. Should boundary detection cover non-blank-line boundaries (setext/HR/HTML/fence-open), and should a
   fence opened inside a live tail switch the block to `mode: "code"` immediately?
5. Is a full-text fallback acceptable (vs tail-only) when `refs` is detected, given earlier blocks are frozen?
6. Is the residual per-delta `heal(raw)` acceptable for boundary-less tails, or must it be bounded?
7. Confirm `LIVE_TAIL_MAX = 2048` with a benchmark sweep across fixture sizes rather than taking the
   original constant as-is.
8. Should this port also adopt #54427's `--conditions=browser` test script change, or keep them separate?
