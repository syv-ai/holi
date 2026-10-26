/**
 * What the bottom panel's context chips show about a shell
 * (docs/features/status-bar.md): where it is, and the git work there.
 *
 * - **Where**: the OSC 7 the shell integration prints at every prompt
 *   (`shell-integration.ts`), read off the PTY's bytes here in main, where it
 *   is validated (a local `file:` URL naming an existing directory). A shell
 *   without the integration is asked of the OS instead (`lsof`).
 * - **Git**: the branch (`rev-parse`), the changed files (`status
 *   --porcelain=v2`, untracked ones included) and the lines added and removed
 *   (`diff --numstat HEAD`): plumbing and porcelain only.
 *
 * Pure Node; the git and lsof runs are injectable for the tests.
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { isAbsolute, normalize, sep } from 'node:path'

/** The git work under a shell's cwd. */
export interface GitSummary {
  /** `main`; `HEAD` when detached. */
  branch: string
  /** Changed paths, tracked and untracked. */
  files: number
  added: number
  removed: number
}

/** What the chips show. */
export interface TerminalContext {
  /** The absolute cwd. */
  cwd: string
  /** The cwd with the home folder as `~`. */
  label: string
  /** Null outside a work tree. */
  git: GitSummary | null
}

// ── OSC 7 ────────────────────────────────────────────────────────────────

const OSC7 = '\x1b]7;'
/** A sequence that never ends is dropped past this. */
const MAX_OSC = 4096

/**
 * Reads OSC 7 out of a PTY's stream, a chunk at a time: a sequence split
 * across two chunks is held until its terminator (BEL or ST) arrives.
 * Returns the payload of each complete one, in order.
 */
export function createOsc7Scanner(): (chunk: string) => string[] {
  let carry = ''
  return (chunk) => {
    let text = carry + chunk
    carry = ''
    const found: string[] = []
    for (;;) {
      const start = text.indexOf(OSC7)
      if (start === -1) {
        // Keep a tail that could be the start of the introducer.
        const esc = text.lastIndexOf('\x1b')
        if (esc !== -1 && OSC7.startsWith(text.slice(esc))) carry = text.slice(esc)
        return found
      }
      const body = start + OSC7.length
      const bel = text.indexOf('\x07', body)
      const st = text.indexOf('\x1b\\', body)
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
      if (end === -1) {
        if (text.length - start <= MAX_OSC) carry = text.slice(start)
        return found
      }
      found.push(text.slice(body, end))
      text = text.slice(end + (end === st ? 2 : 1))
    }
  }
}

/** The local hostnames an OSC 7 may name: a remote one (an ssh session
 *  reporting its own cwd) is not a path on this machine. */
function isLocalHost(host: string, local: string): boolean {
  const h = host.toLowerCase()
  const l = local.toLowerCase()
  return h === '' || h === 'localhost' || h === l || h === l.replace(/\.local$/, '')
}

/**
 * The absolute path an OSC 7 payload (`file://host/path`) names, or null when
 * it is not a well-formed local file URL. Does not touch the disk.
 */
export function parseOsc7(payload: string, localHost: string = hostname()): string | null {
  let url: URL
  try {
    url = new URL(payload)
  } catch {
    return null
  }
  if (url.protocol !== 'file:') return null
  if (!isLocalHost(url.hostname, localHost)) return null
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (path.includes('\0') || !isAbsolute(path)) return null
  const clean = normalize(path)
  return clean.length > 1 && clean.endsWith(sep) ? clean.slice(0, -1) : clean
}

/** `path` as the chips show it: the home folder as `~`. */
export function homeLabel(path: string, home: string = homedir()): string {
  if (home === '' || home === sep) return path
  if (path === home) return '~'
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
}

/** Whether `path` is a directory that exists now. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

// ── lsof (the fallback) ──────────────────────────────────────────────────

/** The cwd in `lsof -a -p PID -d cwd -Fn` output: its `n` field. */
export function parseLsofCwd(out: string): string | null {
  for (const line of out.split('\n')) {
    if (line.startsWith('n') && line.length > 1) {
      const path = line.slice(1)
      return isAbsolute(path) ? path : null
    }
  }
  return null
}

export type RunFile = (file: string, args: string[], cwd?: string) => Promise<string>

/** A child process's stdout, or a rejection. Bounded in time and size. */
const defaultRun: RunFile = (file, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
        // Never take the index lock: the sync engine runs git in the vault
        // too, and a refresh must not make its commit fail.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })

/** A process's cwd as the OS reports it, or null. */
export async function processCwd(pid: number, run: RunFile = defaultRun): Promise<string | null> {
  try {
    return parseLsofCwd(await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']))
  } catch {
    return null
  }
}

// ── git ──────────────────────────────────────────────────────────────────

/** Changed paths in `git status --porcelain=v2 -z` output: ordinary (`1`),
 *  renamed or copied (`2`, whose original path is the next NUL field),
 *  unmerged (`u`) and untracked (`?`) entries. Ignored (`!`) and headers
 *  (`#`) are not changes. */
export function countStatusV2(out: string): number {
  const fields = out.split('\0')
  let files = 0
  for (let i = 0; i < fields.length; i++) {
    const kind = fields[i]![0]
    if (kind === '1' || kind === 'u' || kind === '?') files++
    else if (kind === '2') {
      files++
      i++ // the original path
    }
  }
  return files
}

/** Lines added and removed in `git diff --numstat -z` output. A binary
 *  file's `-` counts nothing. */
export function sumNumstat(out: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i]!)
    if (m === null) continue
    if (m[1] !== '-') added += Number(m[1])
    if (m[2] !== '-') removed += Number(m[2])
    // A rename's paths follow as two more NUL fields when the third is empty.
    if (m[3] === '') i += 2
  }
  return { added, removed }
}

/** git's empty tree: what a repository without a commit is diffed against. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * The git work under `cwd`, or null outside a work tree (or with no git).
 */
export async function gitSummary(
  cwd: string,
  run: RunFile = defaultRun,
  git: string = 'git',
): Promise<GitSummary | null> {
  let inside: string
  try {
    inside = (await run(git, ['rev-parse', '--is-inside-work-tree'], cwd)).trim()
  } catch {
    return null
  }
  if (inside !== 'true') return null
  const [branch, status, base] = await Promise.all([
    run(git, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
      .then((s) => s.trim())
      // No commit yet: the branch HEAD will make.
      .catch(() =>
        run(git, ['symbolic-ref', '--short', 'HEAD'], cwd)
          .then((s) => s.trim())
          .catch(() => 'HEAD'),
      ),
    run(git, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], cwd).catch(() => ''),
    run(git, ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd)
      .then(() => 'HEAD')
      .catch(() => EMPTY_TREE),
  ])
  const numstat = await run(git, ['diff', '--numstat', '-z', base], cwd).catch(() => '')
  return { branch, files: countStatusV2(status), ...sumNumstat(numstat) }
}
