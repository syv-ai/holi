/**
 * Finding a command-line tool from a GUI app. A Dock-launched app does not
 * inherit a login shell's PATH, so `claude` or `pre-commit` installed under
 * `~/.local/bin` is not on `process.env.PATH`. Look there first, then on the
 * login shell's PATH (read once at launch, `loadLoginPath`), then in the usual
 * install directories, for when the shell could not be asked.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where tools usually land; relative entries are under the home directory. */
const FALLBACK_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '.local/bin',
  '.bun/bin',
  '.volta/bin',
  '.npm-global/bin',
  'n/bin',
]

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The fallback directories, absolute. */
function fallbackDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? homedir()
  return FALLBACK_BIN_DIRS.map((dir) => (dir.startsWith('/') ? dir : join(home, dir)))
}

/** The login shell's PATH entries, once `loadLoginPath` has read them. */
let loginPath: string[] = []

/** How long the login shell gets to start; a slow rc file is not worth a hang. */
const LOGIN_SHELL_TIMEOUT_MS = 5_000
const MARK = '__HOLI_LOGIN_PATH__'

type RunShell = (shell: string, args: string[]) => Promise<string>

const runShell: RunShell = (shell, args) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      shell,
      args,
      { timeout: LOGIN_SHELL_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
    child.stdin?.end()
  })

/**
 * Ask the user's login shell for its PATH, once, as VS Code does: what
 * Homebrew, nvm or a `~/.zprofile` put there is what a person expects every
 * command Holi starts to find. The rc files may print anything, so the PATH is
 * read between markers. On failure (no `$SHELL`, a timeout, Windows) the
 * fallback directories still apply.
 */
export async function loadLoginPath(
  env: NodeJS.ProcessEnv = process.env,
  run: RunShell = runShell,
): Promise<void> {
  const shell = env.SHELL
  if (process.platform === 'win32' || !shell) return
  try {
    const out = await run(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`])
    const path = out.split(MARK)[1]
    if (path !== undefined) loginPath = path.split(':').filter((dir) => dir.startsWith('/'))
  } catch {
    // Keep what we had; the fallback directories cover the usual installs.
  }
}

/** PATH, then the login shell's, then the fallback directories, each once:
 *  where `resolveBin` looks, and the PATH for a tool that runs others
 *  (pre-commit's `language: system` hooks, the agent's commands). */
export function toolPath(env: NodeJS.ProcessEnv = process.env): string {
  const dirs = [...(env.PATH ?? '').split(':'), ...loginPath, ...fallbackDirs(env)]
  return [...new Set(dirs.filter(Boolean))].join(':')
}

/** The executable `name` on `toolPath`, else null. */
export function resolveBin(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of toolPath(env).split(':')) {
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/** Where Holi's last-resort `node` lives, under its own `bin` directory. Kept
 *  apart from `holi` so it can sit last on a PATH while `holi` sits first. */
export function nodeFallbackDir(binDir: string): string {
  return join(binDir, 'fallback')
}
