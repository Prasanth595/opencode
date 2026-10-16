export * as WindowsPowershellEncodingGuardPlugin from "./windows-powershell-encoding-guard.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"

// Port of DeepWorks' windows-powershell-encoding-guard plugin (de-branded).
//
// Windows PowerShell 5.1 defaults to the system ANSI codepage rather than
// UTF-8, and several common patterns silently corrupt non-ASCII data. Core
// selects pwsh when available but falls back to Windows PowerShell 5.1 without
// configuring the console encoding (no OutputEncoding/chcp handling anywhere
// in packages/core), so on Chinese Windows machines without PS 7 the failure
// modes below still bite. Appending this warning to the shell tool description
// makes them visible to the model at the point where it composes commands.
//
// The header is phrased conditionally: on machines where pwsh is selected the
// guidance is unnecessary, and an unconditional "your shell is PS 5.1" claim
// would be wrong there.

export const MARKER = "WINDOWS_ENCODING_V1"

const WARNING = `[${MARKER}]
If the shell on Windows is PowerShell 5.1 (not PS 7): the default encoding is the system ANSI/ASCII codepage, not UTF-8, and the patterns below silently corrupt non-ASCII data (e.g. CJK text).
- Piping a script (\`... | powershell -Command -\`): \`$OutputEncoding\` defaults to us-ascii, so CJK becomes \`?\`. Use \`powershell -Command "<script>"\` or \`-EncodedCommand\` instead.
- A BOM-less UTF-8 \`.ps1\` is parsed as ANSI (936), causing syntax or literal errors. Write scripts with \`Set-Content -Encoding UTF8\` (or \`[System.IO.File]::WriteAllText($p, $t, [System.Text.UTF8Encoding]::new($true))\`).
- \`Get-Content\` / \`Set-Content\` do not default to UTF-8: always pass \`-Encoding UTF8\` for files with non-ASCII content.
- \`Invoke-RestMethod\` / \`Invoke-WebRequest\` decode as ISO-8859-1 when the response lacks \`charset\`, turning UTF-8 CJK into mojibake. Prefer asking the server for \`charset=utf-8\`; otherwise decode raw bytes explicitly: \`$r = Invoke-WebRequest -Uri $u -UseBasicParsing; $j = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())\`. Already-corrupted data recovers losslessly: \`[System.Text.Encoding]::UTF8.GetString([byte[]][char[]]$bad)\`.
- To match CJK text, do not pass it through shell arguments: build it from \`[char]\` code points (e.g. \`[char]0x6D4B + [char]0x8BD5\`), or write the pattern to a UTF-8 file and use \`rg -f <pattern-file>\`.
To display CJK correctly, run \`[Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false)\` first; only when the output consumer also decodes as UTF-8, otherwise the mojibake just moves downstream.`

export function isShellToolId(toolID: unknown) {
  if (typeof toolID !== "string") return false
  const leaf = toolID.trim().toLowerCase().split(".").at(-1)
  return leaf === "shell" || leaf === "bash"
}

export function buildDescription(description: unknown) {
  if (typeof description !== "string") return ""
  if (description.includes(MARKER)) return description
  return `${description.trimEnd()}\n\n${WARNING}`
}

export const Plugin = define({
  id: "opencode.guard.windows.encoding",
  effect: (ctx) => {
    if (process.platform !== "win32") return Effect.void
    return ctx.tool
      .transform((editor) => {
        editor.update("shell", (tool) => {
          tool.description = buildDescription(tool.description)
        })
      })
      .pipe(Effect.asVoid)
  },
})
