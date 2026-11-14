/**
 * Finding a command-line tool from a GUI app. A Dock-launched app does not
 * inherit a login shell's PATH, so `claude` or `pre-commit` installed under
 * `~/.local/bin` is not on `process.env.PATH`. Look on the login shell's PATH
 * (read once at launch, `loadLoginPath`), then on the inherited one, then in
 * the usual install directories, for when the shell could not be asked.
 *
 * On Windows the same lookup runs with `;` for the delimiter, the `Path` key
 * Explorer hands an app, and `PATHEXT` for the extension: `claude.exe` before
 * `claude.cmd`, and never the extensionless sh shim npm writes beside a `.cmd`
 * (Windows would call it executable, and cannot run it).
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** The OS a lookup is for; tests inject it to exercise both branches anywhere. */
export type Platform = NodeJS.Platform

const pathFor = (platform: Platform): typeof posix => (platform === 'win32' ? win32 : posix)

/** `;` on Windows, `:` elsewhere. */
export const delimiterFor = (platform: Platform = process.platform): string =>
  pathFor(platform).delimiter

/** Where tools usually land on macOS and Linux; relative entries are under the
 *  home directory. */
const FALLBACK_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '.local/bin',
  '.bun/bin',
  '.volta/bin',
  '.npm-global/bin',
  'n/bin',
]

/** Where they land on Windows: Claude Code's installer (`~\.local\bin`), npm's
 *  global folder, Node itself, and the version managers' shim folders. */
function windowsFallbackDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.USERPROFILE ?? env.HOME ?? homedir()
  const appData = env.APPDATA ?? win32.join(home, 'AppData', 'Roaming')
  const localAppData = env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local')
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  return [
    win32.join(home, '.local', 'bin'),
    win32.join(appData, 'npm'),
    win32.join(home, '.bun', 'bin'),
    win32.join(home, '.volta', 'bin'),
    win32.join(localAppData, 'Volta', 'bin'),
    win32.join(home, 'scoop', 'shims'),
    win32.join(programFiles, 'nodejs'),
  ]
}

/** The key the PATH is under in `env`: Windows names it `Path` when Explorer
 *  starts a program, and its lookups ignore case.
 * @public exported for its test */
export function pathKey(env: NodeJS.ProcessEnv, platform: Platform = process.platform): string {
  if (platform !== 'win32') return 'PATH'
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

/** The PATH `env` carries, under whatever case its key has. */
export function readPath(env: NodeJS.ProcessEnv, platform: Platform = process.platform): string {
  if (platform !== 'win32') return env.PATH ?? ''
  // A copy made on the way here can hold two keys, a real `Path` and a
  // lowercase-joined `PATH`: the first one is the one Windows reads.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH' && env[key] !== undefined) return env[key]!
  }
  return ''
}

/**
 * `env` with its PATH set to `value`, under one key. A Windows environment
 * copied from `process.env` keeps `Path`; writing `PATH` beside it leaves two
 * keys, and each consumer reads a different one.
 */
export function withPath<T extends NodeJS.ProcessEnv>(
  env: T,
  value: string,
  platform: Platform = process.platform,
): T {
  const out: NodeJS.ProcessEnv = { ...env }
  const key = pathKey(env, platform)
  if (platform === 'win32') {
    for (const k of Object.keys(out)) if (k.toUpperCase() === 'PATH') delete out[k]
  }
  out[key] = value
  return out as T
}

/** The runnable extensions on Windows, in `PATHEXT` order. Only what Holi can
 *  start: `.exe` and `.com` directly, `.cmd` and `.bat` through `cmd.exe`. */
const RUNNABLE = new Set(['.com', '.exe', '.bat', '.cmd'])
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1]
  const listed = (raw ?? DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => RUNNABLE.has(ext))
  // `.exe` first, whatever the machine lists: a real program beats a launcher.
  const exe = listed.filter((ext) => ext === '.exe')
  return [...new Set([...exe, ...listed, ...(listed.length === 0 ? ['.exe', '.cmd'] : [])])]
}

function isExecutable(path: string, platform: Platform): boolean {
  try {
    if (platform === 'win32') return statSync(path).isFile()
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The fallback directories, absolute. */
function fallbackDirs(env: NodeJS.ProcessEnv, platform: Platform): string[] {
  if (platform === 'win32') return windowsFallbackDirs(env)
  const home = env.HOME ?? homedir()
  return FALLBACK_BIN_DIRS.map((dir) => (dir.startsWith('/') ? dir : posix.join(home, dir)))
}

/** The login shell's PATH entries, once `loadLoginPath` has read them. */
let loginPath: string[] = []

/** How long the login shell gets to start; a slow rc file is not worth a hang. */
const LOGIN_SHELL_TIMEOUT_MS = 5_000
const MARK = '__HOLI_LOGIN_PATH__'

type RunShell = (shell: string, args: string[]) => Promise<string>

/** Runs the shell in a process group of its own, with no terminal and no
 *  input, and settles by the timeout whatever the shell does: an interactive
 *  zsh or bash ignores SIGTERM, so the group is killed and what it printed so
 *  far is read. */
const runShell: RunShell = (shell, args) =>
  new Promise((resolve) => {
    let out = ''
    let settled = false
    let leaderExited = false
    const child = spawn(shell, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PATH: toolPath(), HOLI_RESOLVING_ENVIRONMENT: '1' },
    })
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!leaderExited) {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        } catch {
          // The group has already exited.
        }
      }
      resolve(out)
    }
    const timer = setTimeout(done, LOGIN_SHELL_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out = (out + chunk).slice(-64 * 1024)
    })
    child.on('error', done)
    child.on('exit', () => {
      leaderExited = true
    })
    child.on('close', done)
  })

/**
 * Ask the user's login shell for its PATH, once, as VS Code does: what
 * Homebrew, nvm or a `~/.zprofile` put there is what a person expects every
 * command Holi starts to find. The rc files may print anything, so the PATH is
 * read between markers. On failure (no `$SHELL`, a timeout, Windows, which has
 * no login shell to ask) the fallback directories still apply.
 * `HOLI_RESOLVING_ENVIRONMENT=1` lets an rc file skip heavy work.
 */
export async function loadLoginPath(
  env: NodeJS.ProcessEnv = process.env,
  run: RunShell = runShell,
  platform: Platform = process.platform,
): Promise<void> {
  const shell = env.SHELL
  if (platform === 'win32' || !shell) return
  try {
    const out = await run(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`])
    // Both markers, or the read was cut short.
    const parts = out.split(MARK)
    const path = parts.length >= 3 ? parts[1] : undefined
    if (path !== undefined) loginPath = path.split(':').filter((dir) => dir.startsWith('/'))
  } catch {
    // Keep what we had; the fallback directories cover the usual installs.
  }
}

/** The login shell's PATH, then what this process inherited, then the
 *  fallback directories, each once: where `resolveBin` looks, and the PATH for
 *  a tool that runs others (pre-commit's `language: system` hooks, the agent's
 *  commands). The login shell's comes first, as in a terminal: a Dock-launched
 *  app inherits `/usr/bin:/bin:…`, which would put Apple's `python3` or `git`
 *  ahead of Homebrew's and skip version-manager shims. On Windows the entries
 *  are joined with `;` and compared without regard to case. */
export function toolPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): string {
  const { delimiter } = pathFor(platform)
  const dirs = [
    ...loginPath,
    ...readPath(env, platform).split(delimiter),
    ...fallbackDirs(env, platform),
  ]
  const seen = new Set<string>()
  const unique: string[] = []
  for (const dir of dirs) {
    if (dir === '') continue
    const id = platform === 'win32' ? dir.toLowerCase().replace(/[\\/]+$/, '') : dir
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(dir)
  }
  return unique.join(delimiter)
}

/** Options for tests: the OS to look as, and what counts as a file there. */
export interface ResolveOptions {
  platform?: Platform
  isFile?: (path: string) => boolean
}

/** The executable `name` on `toolPath`, else null. On Windows a bare name
 *  gets each runnable `PATHEXT` extension in turn (a name that already ends in
 *  one is tried as it is), and a bare, extensionless file never matches. */
export function resolveBin(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  { platform = process.platform, isFile }: ResolveOptions = {},
): string | null {
  const path = pathFor(platform)
  const is = isFile ?? ((candidate: string) => isExecutable(candidate, platform))
  const names =
    platform === 'win32'
      ? RUNNABLE.has(path.extname(name).toLowerCase())
        ? [name]
        : windowsExtensions(env).map((ext) => name + ext)
      : [name]
  for (const dir of toolPath(env, platform).split(path.delimiter)) {
    for (const candidate of names) {
      const full = path.join(dir, candidate)
      if (is(full)) return full
    }
  }
  return null
}

/** Whether `path` is a program Holi can start: on Windows a file with a
 *  runnable extension, elsewhere a file with the execute bit. */
export function isRunnable(
  path: string,
  { platform = process.platform, isFile }: ResolveOptions = {},
): boolean {
  const is = isFile ?? ((candidate: string) => isExecutable(candidate, platform))
  if (platform === 'win32' && !RUNNABLE.has(win32.extname(path).toLowerCase())) return false
  return is(path)
}

/** Where Holi's last-resort `node` lives, under its own `bin` directory. Kept
 *  apart from `holi` so it can sit last on a PATH while `holi` sits first. */
export function nodeFallbackDir(binDir: string, platform: Platform = process.platform): string {
  return pathFor(platform).join(binDir, 'fallback')
}
