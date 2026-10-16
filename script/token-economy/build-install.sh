#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
command -v bun >/dev/null || { echo 'Bun 1.4.2 is required; install it before building.' >&2; exit 1; }
echo '== install project dependencies =='
bun install --frozen-lockfile
echo '== regression suite =='
(cd packages/core && bun test test/token-economy.test.ts && bun run typecheck)
echo '== build this host target =='
bun run --cwd packages/cli build --single
TARGET="$(find "$ROOT/packages/cli/dist" -type f -path '*/bin/opencode' -print -quit)"
if [[ -z "$TARGET" || ! -x "$TARGET" ]]; then echo 'Build did not produce an executable' >&2; exit 1; fi
"$TARGET" --version
mkdir -p "$HOME/.local/bin"
install -m 755 "$TARGET" "$HOME/.local/bin/opencode-token-economy"
echo "Installed: $HOME/.local/bin/opencode-token-economy"
echo 'Launch: ~/.local/bin/opencode-token-economy .'
