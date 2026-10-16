# OpenCode 2.0.30 token-economy fork

**Artifact status:** Updated complete source branch. The accompanying tarball is **not** a precompiled executable; Bun is required to compile it. Source came from your uploaded `opencode_033_16_10_26.tar.gz` archive.

## Build and install on Linux

Extract the archive, change into the extracted project root (`opencode/`), then:

```bash
bash script/token-economy/build-install.sh
```

The script installs dependencies, runs the new regression suite and the package's typecheck, builds the native Linux executable for the host CPU, verifies `--version`, then installs **a separate binary** to `~/.local/bin/opencode-token-economy`. Your currently installed `opencode` executable is left unchanged.

Launch with:

```bash
~/.local/bin/opencode-token-economy .
```

You can disable request-history deduplication without recompiling:

```bash
OPENCODE_TOKEN_ECONOMY=0 ~/.local/bin/opencode-token-economy .
```

GitHub web-fetch requests in Markdown mode focus on a unique HTML `<main>` element by default. Explicit `focus: "full"` in the webfetch tool restores full-page HTML conversion. Other sites retain the previous full-page default.

## Preflight

```bash
bun --version
bash -n script/token-economy/build-install.sh
(cd packages/core && bun test test/token-economy.test.ts)
(cd packages/core && bun run typecheck)
```

Use the included report `docs/token-economy/README.md` for measured export-volume data, source-change rationale, caveats, and A/B test design. The 120 largest export spans are in `docs/token-economy/ranked-120.md` and `.csv`.

## Upgrade safety

This changes the source branch you provided. It does not patch any installed global binary or local preferences. Avoid replacing `~/.local/bin/opencode` until the separately named fork passes real workload tests.
