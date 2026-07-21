/**
 * The git engine — Holi's sync, run against the system `git` binary.
 *
 * **Why the binary and not a JS implementation** (`prd/vaults-sync.md` §How git
 * is run): merge-with-honest-conflict-reporting is the load-bearing operation in
 * the whole sync design — FR-12 and the entire reconcile path rest on git
 * *refusing* rather than guessing — and that is precisely isomorphic-git's
 * weakest area. Shelling out also inherits credential helpers, hooks, and
 * `.gitignore` semantics, and behaves identically to what the user and the agent
 * see in a terminal, which is where they both end up when a merge goes wrong.
 *
 * **The rule that contains the cost:** parse only plumbing commands and
 * `--porcelain=v2`. Human-readable porcelain is explicitly not a stable
 * interface, and a locale or git-version change would silently alter it.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A git command that ran and failed. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

/** There is no `git` on this machine. Its own type because the response is
 * advice — install git — not a stack trace. The product assumes every user is a
 * developer, but assuming is not the same as failing well when wrong. */
export class GitMissingError extends Error {
  constructor(readonly gitPath: string) {
    super(`\`${gitPath}\` was not found. Holi needs the git command-line tool installed.`)
    this.name = 'GitMissingError'
  }
}

export interface GitDeps {
  /** The GitHub token, read lazily so a sign-out takes effect on the next
   * operation rather than on the next restart. */
  token?: () => string | null
  /** Commit identity, so Holi works on a machine that has never configured git. */
  identity?: { name: string; email: string }
  /** Overridable for tests only. */
  gitPath?: string
}

/** Bounded so a large `git log` cannot silently truncate: execFile's default is
 * 1MB and it fails the command rather than streaming. */
const MAX_BUFFER = 64 * 1024 * 1024

const WINDOWS = process.platform === 'win32'

/**
 * The credential answerer git will call, written to disk on first use.
 *
 * **Why the token goes through here at all.** It must not reach a command line —
 * `-c http.extraheader=…` puts it in argv, where other processes can read it —
 * and it must not be baked into the remote URL, where it would persist in
 * `.git/config` long after sign-out. An environment variable is readable only by
 * the same user, and `GIT_ASKPASS` is how git reads one.
 *
 * **Why it is materialized rather than shipped.** A file beside the source does
 * not survive `electron-vite`'s bundle of main into `out/main/`, and resolving
 * its path would need `import.meta.url`, which does not survive the CJS build
 * either. Writing it at runtime sidesteps both, and works identically under
 * vitest, `electron-vite dev`, and a packaged app.
 *
 * **Why a shell script and not node.** It must run with no interpreter
 * assumptions: git executes this directly, and a `#!/usr/bin/env node` shebang
 * depends on a working `node` on PATH, which is not a given.
 *
 * The directory comes from `mkdtemp`, so it is 0700 and unpredictable — no other
 * user can pre-create the path and have git execute their script instead.
 */
let askpassPromise: Promise<string> | null = null

export function ensureAskpass(): Promise<string> {
  askpassPromise ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-git-'))
    const file = join(dir, WINDOWS ? 'askpass.bat' : 'askpass.sh')
    const body = WINDOWS
      ? '@echo off\r\nif not "%~1"=="%~1:Username=%" (echo x-access-token) else (echo %HOLI_GIT_TOKEN%)\r\n'
      : // `case` rather than a regex: this has to be POSIX sh, not bash.
        '#!/bin/sh\ncase "$1" in *sername*) echo "x-access-token";; *) echo "$HOLI_GIT_TOKEN";; esac\n'
    await writeFile(file, body, { mode: 0o700 })
    return file
  })()
  return askpassPromise
}

export interface RunOpts extends Pick<GitDeps, 'token' | 'gitPath'> {}

/** The result of a command allowed to fail. */
export interface GitOutcome {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

/**
 * Run one git command and return its stdout, trimmed. Throws `GitError` on a
 * non-zero exit and `GitMissingError` when the binary is absent.
 *
 * Uses `execFile`, never a shell: every argument crosses as an argument, so a
 * filename containing a space or a semicolon is a filename and not a second
 * command.
 */
export async function runGit(cwd: string, args: string[], opts: RunOpts = {}): Promise<string> {
  const result = await tryGit(cwd, args, opts)
  if (!result.ok) {
    throw new GitError(
      `git ${args[0]} failed (${result.code}): ${result.stderr.split('\n')[0] ?? ''}`,
      result.code,
      result.stderr,
    )
  }
  return result.stdout.trim()
}

/**
 * Run one git command and report how it went without throwing.
 *
 * Failure is an ordinary outcome for several operations here — a merge that
 * conflicts, a push that is rejected — and each carries information in its exit
 * code that an exception would flatten into a message.
 */
export async function tryGit(
  cwd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<GitOutcome> {
  const gitPath = opts.gitPath ?? 'git'
  const askpass = await ensureAskpass()
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      args,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        env: {
          ...process.env,
          // Never block on an interactive prompt: there is no terminal attached
          // to an Electron main process, so a prompt is a permanent hang.
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: askpass,
          HOLI_GIT_TOKEN: opts.token?.() ?? '',
          // Stable messages regardless of the user's locale. We parse porcelain
          // rather than prose, but stderr still reaches error messages and logs.
          LC_ALL: 'C',
        },
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new GitMissingError(gitPath))
        }
        const code = err ? ((err as { code?: number }).code ?? 1) : 0
        resolve({ ok: !err, code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}
