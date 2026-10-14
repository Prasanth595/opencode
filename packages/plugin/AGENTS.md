# Plugin Package Guide

- The server SDK has two versions: Effect and Promise. `src/tui/` is the TUI SDK and `src/gui/` the GUI SDK.
- In the Effect version, every domain must extend the corresponding Effect API client interface from `@opencode/client/effect/api`.
- Do not redefine functions that already exist on the Effect API client interface.
- Plugin domains add only the additional functions that make sense in the plugin context.
- The GUI SDK never loads in the server or the TUI, so `runtime-modules.ts` skips `gui/` and the CLI bundle does not grow.
- `src/gui/` follows `packages/gui-plugins/AGENTS.md`: the built-ins there are its main users, and `bun run lint` checks its TSDoc (`script/sdk-docs.ts`). Run `bun run generate` here after the app's icon catalog changes.
