# Markdown streaming incremental projection — benchmark

Benchmark of `project()` in `packages/session-ui/src/components/markdown-stream.ts`
for the V2 port of [anomalyco/opencode#48432](https://github.com/anomalyco/opencode/pull/48432)
("grow markdown live tail in place"). The baseline is unmodified `origin/dev`; the
candidate is the `markdown-incremental-projection` feature branch.

## Conclusion

The optimization is worthwhile. It removes repeated full-message lexing during
streaming and changes total projection work for ordinary prose from roughly
quadratic to near-linear in response length.

- For a 12.6 KB boundary-less paragraph streamed one word per delta, cumulative
  projection time drops from **10,828 ms to 91 ms (~119×)** and total characters
  handed to the marked lexer drop from **63,152,630 to 20**.
- Every measured workload improves; none regresses.
- No implementation change is required. The optimization already fixes a latent
  partition bug in the baseline (see "Partition correctness" below).

## Environment and runtime

|         |                                                      |
| ------- | ---------------------------------------------------- |
| Host    | Linux 6.8.0-147-generic x86_64, Ubuntu 24.04.5 LTS   |
| CPU     | AMD Ryzen Threadripper 1920X (12 cores / 24 threads) |
| RAM     | 64 GB                                                |
| Runtime | Bun 1.4.2                                            |
| Marked  | 18.0.11 (workspace catalog)                          |
| Remend  | 1.3.1                                                |

Both revisions were measured on the same machine, in the same Bun runtime, with
the same harness, in the same session, back to back.

## Revisions

|                                     | Revision                                   | `markdown-stream.ts` blob                  |
| ----------------------------------- | ------------------------------------------ | ------------------------------------------ |
| Baseline (`origin/dev`, unmodified) | `d0732eadf883bdc64c0b0ea91e9c4ee0fe51d8c3` | `4879a09f5022cfaba12b7167e37d804b5e82a84c` |
| Feature branch (implementation)     | `e2260534d13d7d60f4fe23f304c1fce08e2ab240` | `049402b93ab29b2a44a415ccae331892469b212e` |

The implementation is the two commits on top of the port-plan doc:
`ab76b878ce` (grow live tail in place) and `e2260534d1` (correct edge cases:
`liveSource`, fence-open detection, frozen display math, late reference
definitions, and rebuilding the tail from source). The benchmark harness and
this report are committed on top of that as a separate benchmarking commit.

The baseline was checked out in an isolated git worktree at
`/tmp/opencode/md-baseline` (detached at `origin/dev`); the feature branch was
never reset or modified. Both runs used the identical harness file
(SHA-256 `330f1300…` for `project.bench.ts`); the baseline worktree shared the
main checkout's `node_modules` via symlink to guarantee identical dependency
resolution.

## Harness

The harness streams deterministic fixtures through
`project(previous, text, true)` with the same small-delta cadence a provider
emits tokens. It calls `project()` directly — no Solid store, no worker, no DOM
— so it measures projection CPU only.

- File: `packages/session-ui/performance/markdown-stream/project.bench.ts`
  (main workloads) and `.../scale.bench.ts` (size sweep).
- Run from `packages/session-ui`:
  `bun performance/markdown-stream/project.bench.ts out.json 5`.
- Timing: `Bun.nanoseconds()` around each `project()` call. Reported total is the
  sum of per-call times; per-update latency is the distribution of those calls.
- Warm-up: one full pass per workload is executed before the measured passes.
- Repetitions: 5 measured passes per workload (the size sweep uses 1 measured
  pass per size after a JIT-priming run, because the baseline is very slow).
- Lexer instrumentation: `Marked.prototype.lexer` is wrapped to count calls and
  accumulate the characters passed in. `refs()` shortcut text never reaches the
  lexer, so the counters reflect actual re-lex work.

### Workloads and input sizes

| Workload                   | Deltas | Final chars | Delta size                                 | Shape                                                                                   |
| -------------------------- | ------ | ----------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `many-paragraph-deltas`    | 200    | 9,251       | ~46 chars (a short paragraph + blank line) | every delta adds a block boundary                                                       |
| `one-long-paragraph`       | 2,000  | 12,626      | one word + space                           | boundary-less; grows the live tail                                                      |
| `completed-head-live-tail` | 500    | 5,233       | one word + space                           | 40 completed paragraphs delivered as a prefix, then a growing tail                      |
| `mixed-long-response`      | 1,282  | 10,254      | 8-char chunks                              | headings, prose, lists, a table, and TypeScript fences — a representative long response |
| `growing-list`             | 300    | 12,272      | one item                                   | list items appended                                                                     |
| `growing-table`            | 302    | 8,601       | one row                                    | table rows appended                                                                     |
| `open-code-fence`          | 401    | 8,186       | one line                                   | open `ts` fence streamed                                                                |

## Results

### Main workloads (median of 5 passes)

| Workload                   | Baseline total | Modified total | Speedup | Baseline lex calls | Modified lex calls | Baseline lex chars | Modified lex chars |
| -------------------------- | -------------- | -------------- | ------- | ------------------ | ------------------ | ------------------ | ------------------ |
| `many-paragraph-deltas`    | 155.5 ms       | 3.5 ms         | 44.7×   | 1,000              | 25                 | 4,640,465          | 41,710             |
| `one-long-paragraph`       | 10,827.6 ms    | 90.7 ms        | 119×    | 10,000             | 5                  | 63,152,630         | 20                 |
| `completed-head-live-tail` | 265.0 ms       | 7.8 ms         | 33.9×   | 2,500              | 0                  | 9,151,035          | 0                  |
| `mixed-long-response`      | 902.9 ms       | 21.4 ms        | 42.2×   | 6,010              | 105                | 30,741,870         | 316,520            |
| `growing-list`             | 416.9 ms       | 18.4 ms        | 22.6×   | 1,500              | 5                  | 9,164,700          | 170                |
| `growing-table`            | 164.9 ms       | 13.2 ms        | 12.5×   | 1,510              | 5                  | 6,421,720          | 50                 |
| `open-code-fence`          | 1.4 ms         | 0.8 ms         | 1.8×    | 5                  | 5                  | 30                 | 30                 |

Lexer call counts are totals across the 5 measured passes. The baseline re-lexes
the entire accumulated message once per non-code delta, so its lexer characters
roughly double per doubling of message length. The candidate lexes once at the
start (and re-lexes only the bounded tail when a boundary is crossed), so its
lexer work stays essentially constant.

`open-code-fence` improved only modestly because the baseline already had a
fast path for an open `code` tail; both versions are already fast there. It is
included to show the change does not regress that path.

### Per-update latency (p95 of all measured updates)

| Workload                   | Baseline p95 | Modified p95 |
| -------------------------- | ------------ | ------------ |
| `many-paragraph-deltas`    | 1,445 µs     | 16 µs        |
| `one-long-paragraph`       | 31,698 µs    | 85 µs        |
| `completed-head-live-tail` | 697 µs       | 24 µs        |
| `mixed-long-response`      | 1,436 µs     | 16 µs        |
| `growing-list`             | 2,695 µs     | 114 µs       |
| `growing-table`            | 1,092 µs     | 81 µs        |
| `open-code-fence`          | 8 µs         | 4 µs         |

Per-pass totals were tight (for example `one-long-paragraph` baseline
min/median/max = 10,776 / 10,828 / 10,848 ms; modified = 87.7 / 90.7 / 93.4 ms),
so the differences are far outside run-to-run noise.

### Scaling sweep (boundary-less paragraph, N words)

This is the quadratic evidence. Each size is one measured pass after JIT priming.

| Words | Chars  | Baseline total | Modified total | Baseline lex chars | Modified lex chars |
| ----- | ------ | -------------- | -------------- | ------------------ | ------------------ |
| 250   | 1,576  | 31 ms          | 4.7 ms         | 197,240            | 4                  |
| 500   | 3,151  | 104 ms         | 9.5 ms         | 789,207            | 4                  |
| 1,000 | 6,316  | 391 ms         | 29.7 ms        | 3,157,346          | 4                  |
| 2,000 | 12,626 | 10,793 ms      | 94.4 ms        | 12,630,526         | 4                  |

Baseline lexer characters scale as O(n²): doubling the response roughly
quadruples them. Modified lexer characters are constant (4 — the initial lex
only) because the boundary-less tail is never re-lexed. Baseline total time
grows faster than quadratic at the top end (an additional marked-internal
effect at large input); the candidate remains well under 100 ms.

## Partition correctness observed during benchmarking

Every measured update was checked against the projection contract that
`blocks.map(b => b.raw).join("") === text`.

- Baseline violates it **34 times per pass** on `mixed-long-response`, always by
  dropping a trailing space after a list item (e.g. `"- first item with the "`
  is emitted as `"- first item with the\n"`). The baseline rebuilds the live
  tail from marked's normalized tokens rather than from the source text.
- Modified has **0 mismatches** on every workload and every pass.

This is a correctness improvement contributed by the candidate's
"rebuild the tail from source text" change, not a performance artifact. The
check was excluded from the timed region.

## Limitations

- This measures `project()` CPU only. It does not measure the worker message
  passing, the Solid reactive store, or DOM/HTML re-parsing. The renderer still
  re-walks the node array per delta (tracked separately in #54427); those costs
  are out of scope here and must not be inferred from these numbers.
- Fixtures are synthetic and English-only. Real responses can differ in token
  cadence and markdown mix, but the algorithmic properties measured (per-delta
  lex work, quadratic-vs-linear growth) are workload-independent.
- The candidate keeps a residual per-delta `heal`/`remend` scan of the live
  tail. For a boundary-less tail this is O(tail length) per delta, so total work
  is not strictly linear; the measured candidate scaling from 250 to 2,000 words
  (4.7 ms → 94.4 ms for an 8× input) shows the remaining mild superlinear term,
  with a constant roughly two orders of magnitude below the baseline.
- The size sweep uses one measured pass per size to bound baseline runtime
  (the 2,000-word baseline pass alone takes ~11 s). The main harness uses five.
- Absolute times are machine-specific; the speedup ratios are the relevant
  result.

## Recommendation

Proceed with final PR preparation. The change is a clear, large win for
streaming projection cost with no measured regression, and it additionally
fixes the trailing-space partition bug in the baseline.
