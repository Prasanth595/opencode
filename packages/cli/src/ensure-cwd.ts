import os from "node:os"

/** Recover when the process cwd was deleted out from under the shell (common on WSL remounts). */
export function ensureCwd() {
  try {
    process.cwd()
  } catch {
    const home = os.homedir()
    process.stderr.write(`Current directory is not accessible; using ${home}\n`)
    process.chdir(home)
    // Shells leave $PWD pointing at the deleted path; keep it aligned with the new cwd.
    process.env.PWD = home
  }
}

ensureCwd()
