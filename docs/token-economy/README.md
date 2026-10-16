# OpenCode token-economy branch audit (2026-10-16)

Version audited: supplied OpenCode **2.0.30** source snapshot. Reference harness: supplied Pi source archive. Comparative guidance: Command Code public engineering docs, especially [read](https://commandcode.ai/docs/harness-engineering/read-tool) and [shell](https://commandcode.ai/docs/harness-engineering/shell-tool); Pi's [compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md).

## Evidence and limits

The supplied DeepSeek Markdown export contains **415,055 UTF-8 bytes**, of which the observed classifiable blocks account for: 167,028 characters assistant text (including **164,400 characters of exported `_Thinking:_` content across 57 blocks**), 127,797 shell-result characters, 59,082 web-fetch-result characters, 6,219 read-result characters, and 12,028 write-input characters. This is a **single quota-plugin editing conversation**, not a project coding workload. Actual API-token, cache-hit and spend records are absent. No provider token savings can be verified from this source alone.

The most important causal distinction is **generated reasoning**, **model-visible context size**, **provider-cached context**, and **fresh provider input**. Trimming 50 KB from a past response does not automatically save 50 KB of paid *fresh* input; the provider may have cached it. Conversely, long reasoning can consume expensive output tokens even when tool results are very short.

An exact-text hash comparison of the 88 exported tool outputs found only **nine duplicate output occurrences**, collectively **966 characters**. Therefore deduplicating exact repeated outputs would **not** have materially reduced this particular conversation. The code change is for other workloads with large repeated reads and fetches.

See `ranked-120.md`/`.csv` for the 120 largest observed spans, exact export line numbers, and conservative intervention labels. They are **120 candidate hotspots**, not 120 independently verified redundant behaviors.

## Root causes and implementation decisions

| Priority | Surface / reference | Finding | Decision |
|---:|---|---|---|
| 1 | Conversation: assistant output | 164.4 KB exported thinking alone (39.7% of all transcript characters) | Do not silently truncate reasoning; model prompting/routing is required to address this |
| 2 | Conversation: shell | 127.8 KB results, large repeated source inspection | Existing tool already captures only final 50 KiB plus persistent complete logs; avoid duplicate implementation |
| 3 | Conversation: webfetch | 59.1 KB in only 3 requests, including site-wide GitHub navigation | GitHub Markdown HTML automatically focuses `<main>` when a unique `<main>` exists; `focus: "full"` restores full page |
| 4 | `tool-output.ts` | Generic overflow returned only the beginning of a result, forcing a second read for diagnostics at end | **Implemented** two-end bounded preview for single-text results; full output retained in original file |
| 5 | `runner/to-llm-message.ts` | Every past completed tool result is serialized again | **Implemented** exact-match historical deduplication for large text read/grep/glob/webfetch results at request construction only |
| 6 | `tool/runtime.ts` | Invalid but recoverable model tool argument types cause failed calls and additional reasoning | **Implemented** conservative fallback repair, only when strict original validation failed |
| 7 | `model-request.ts` | One-off summary/title/generation calls shared primary prompt-cache key | **Implemented** independent deterministic cache keys for nonprimary flows |
| 8 | `webfetch.ts` | Other documentation pages may include site chrome | **Implemented** optional `focus: "main"` (defaults to full outside GitHub) |
| 9 | `tool/read-filesystem.ts` | 2000 lines, 50 KiB, 2000-character line cap, media guards already in place | Keep existing safeguards and paging behavior |
| 10 | `shell.ts` | Background job tracking, cursor reads, tail capture, no-poll reminder already in place | Keep existing behavior |
| 11 | `tool/plugin/grep.ts` | Search results have bounded match limits | Retain output shapes; narrow scope when possible |
| 12 | `tool/plugin/glob.ts` | Glob listings are already capped | Retain output shapes |
| 13 | `session/compaction.ts` | Structured checkpoints and size estimates already in place | Do not replace with crude character threshold |
| 14 | `session/compaction.ts` | Each compaction still sends substantial transcript | Preserve summary fidelity; truncation already at 1250 characters per historic tool output |
| 15 | `session/compaction.ts` | Multiple attempts can happen after overflow | Existing shrink steps reviewed; do not introduce arbitrary new fallback |
| 16 | `session/runner/llm.ts` | Request history rebuilt each turn | Historical dedup is request-only so stored messages and user UI remain untouched |
| 17 | `tool/plugin/subagent.ts` | Delegated work has independent model-context costs | No blanket subagent reduction; depends on project instructions |
| 18 | Agent instructions | Large instruction files may consume fixed tokens per request | No silent trimming; preserve priority instructions |
| 19 | Tool schemas | Large MCP/tool catalogs increase prompt size | Not changed; hiding tools could break functionality |
| 20 | `tool-output.ts` | Multi-content outputs can include images/files | Skip dual-end rewriting when more than one content block exists |
| 21 | `tool/plugin/read.ts` | File output has line labels and offsets | Preserve exact line numbering and page continuation |
| 22 | `tool/plugin/shell.ts` | Shell result includes exit/signal/timeout metadata | Preserve metadata and exit behavior |
| 23 | `tool/plugin/webfetch.ts` | Arbitrary HTML-to-markdown conversion | Keep converter and full-HTML escape hatch |
| 24 | `tool/html-markdown.ts` | HTML semantics, tables, preformatted code | Do not globally delete header/footer tags from legitimate content |
| 25 | `session/runner/dedupe-tool-results.ts` | Identical text may recur in history | Use cryptographic exact hash; skip provider-executed and provider-metadata-bound results |
| 26 | Prompt-cache behavior | Rewriting older tool text can invalidate cached prefixes | `OPENCODE_TOKEN_ECONOMY=0` disables historical dedup entirely; compare billed cost in A/B |
| 27 | `tool/input-repair.ts` | Unsafe coercion can corrupt inputs | Coerce only schema-declared primitives; validate again afterward |
| 28 | `tool/input-repair.ts` | Required null arguments should fail | Never remove required null fields |
| 29 | `tool/input-repair.ts` | Out-of-range numbers could silently round | Reject unsafe integer coercion |
| 30 | Full tool output storage | Exact output may be needed after a compact preview | Keep existing saved full-output path and metadata |
| 31 | Native provider state | Model/provider-specific state and reasoning signatures require fidelity | Do not modify parts carrying provider metadata |
| 32 | Quota plugin reports | TUI quota display is outside model context | No harness changes to quota presentation |
| 33 | Reasoning effort | High-effort models can generate more reasoning | Caller-controlled; do not change defaults of supplied branch |
| 34 | Distinct model protocols | Provider output representations differ | No protocol-specific adapter rewriting |
| 35 | Multiple-session usage | Cached tokens vs cumulative totals can be confused | No changes to accounting; benchmark request-by-request |
| 36 | Automated token benchmark | Single transcript cannot prove completion success | Add request-level paired A/B task benchmarks before claiming percentages |

## Changed source files

- `packages/core/src/tool/preview.ts`: pure bounded head-and-tail text preview.
- `packages/core/src/tool-output.ts`: use preview only for a single large text block, preserving metadata/full output.
- `packages/core/src/tool/input-repair.ts` and `packages/core/src/tool/runtime.ts`: schema-guided fallback on failed validation.
- `packages/core/src/tool/main-content.ts` and `packages/core/src/tool/plugin/webfetch.ts`: unique `<main>` extraction for GitHub Markdown HTML by default and explicit focus selection for other sites.
- `packages/core/src/session/runner/dedupe-tool-results.ts` and `packages/core/src/session/model-request.ts`: exact historical result dedup for large read/grep/glob/webfetch text, request-only; disabled via `OPENCODE_TOKEN_ECONOMY=0`.
- `packages/core/src/session/runner/cache-key.ts` and `packages/core/src/session/model-request.ts`: isolate nonprimary cache lineage.
- `packages/core/test/token-economy.test.ts`: regression tests for new helpers.

## Technical risk evaluation

1. Historical output deduplication keeps the newest exact output, but could increase prompt-cache writes by altering an earlier prefix. This is a net-token optimization, **not guaranteed to reduce dollars** on cached-input-heavy providers. Disable with `OPENCODE_TOKEN_ECONOMY=0` if request-level billing rises.
2. Focused GitHub fetches intentionally omit content outside a unique `<main>` element. If the agent needs repository navigation/sidebar content, pass `focus: "full"`. If the site has no unique main, the full document is returned.
3. Schema-based argument repair only acts after validation failed, then validates again. It does not bypass tool permissions.
4. Preview truncation never loses original output from storage; it is a context-only representation change. Structured output and media remain unchanged.
5. The supplied source tree has broken workspace dependency symlinks after extraction, and Bun is not installed in the analysis environment. Syntax/pure helper assertions can be run here, but a production binary and full integration suite cannot be honestly claimed. Use the included `build-install.sh` on a machine with Bun and network access.

## Verification protocol

Use the same working tree revision and model settings for original and modified harnesses. Warm both caches equally. Repeat each task at least three times. Log tokens classified as fresh input, cache reads, cache writes, visible output and reasoning. Record completed task, tests passing, elapsed time and retries. Compare cost **per passing task**, not just raw request size. For a regression, restore `OPENCODE_TOKEN_ECONOMY=0`, verify `focus: "full"`, and inspect affected tool output history before changing any other config.
