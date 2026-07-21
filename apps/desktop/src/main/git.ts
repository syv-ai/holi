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
  /** Commit identity, used **only** when the machine has none of its own — see
   * `commitAll`. Holi does not overwrite a user's configured git identity. */
  identity?: { name: string; email: string }
  /** Overridable for tests only. */
  gitPath?: string
  /** Extra environment for the git child process. Tests use it to simulate a
   * machine with no global config; nothing in the app needs it. */
  env?: Record<string, string>
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

export interface RunOpts extends Pick<GitDeps, 'token' | 'gitPath' | 'env'> {}

export interface RepoStatus {
  branch: string
  /** `origin/HEAD`'s target, or null when the remote has none. FR-2: Holi syncs
   * this branch and no other. */
  defaultBranch: string | null
  ahead: number
  behind: number
  dirty: boolean
  /** A merge is in progress — the state a reconcile runs inside. */
  merging: boolean
  detached: boolean
  /** No commits yet. A repo "New vault" just created is one. */
  unborn: boolean
}

/** A conflict names its paths, because the reconcile prompt is built from them. */
export type PullResult =
  | { kind: 'up-to-date' }
  | { kind: 'merged'; commits: number }
  | { kind: 'conflict'; paths: string[] }

export interface GitRepo {
  readonly root: string
  status(): Promise<RepoStatus>
  /** Fetch and merge the default branch. Never rebases; a conflict aborts. */
  pull(): Promise<PullResult>
  /** Stage everything and commit. Returns the new sha, or **null** when the tree
   * was already clean — "nothing to commit" is the normal outcome of an idle
   * timer on an untouched vault, not an error. */
  commitAll(message: string): Promise<string | null>
}

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
          ...opts.env,
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

/**
 * A vault's clone, as an object you can ask questions of.
 *
 * Every method here is a git invocation — nothing is cached. A vault is written
 * to by Holi, by the user's editor, and by the agent's `Bash`, so a cache would
 * be a fourth opinion about a repo three other things are changing.
 */
export function openRepo(root: string, deps: GitDeps = {}): GitRepo {
  const opts: RunOpts = { token: deps.token, gitPath: deps.gitPath, env: deps.env }

  /** Anything at all to commit? Cheaper than a full `status()`, which also asks
   * about the upstream and MERGE_HEAD — this runs on every idle tick. */
  async function isDirty(): Promise<boolean> {
    const raw = await runGit(root, ['status', '--porcelain=v2', '--untracked-files=all', '-z'], opts)
    return raw.trim() !== ''
  }

  /**
   * Identity flags for a commit — **only** when the machine has none.
   *
   * `-c user.email=…` overrides rather than defaults, so passing it
   * unconditionally would author every commit as Holi and throw away the user's
   * real name in the shared history. But a machine that has never run
   * `git config --global user.email` cannot commit at all, and requiring that
   * setup before Holi works would be a bad first run. So: ask, and fill in only
   * the gap.
   */
  async function identityArgs(): Promise<string[]> {
    const configured = await runGit(root, ['config', '--get', 'user.email'], opts).catch(() => '')
    if (configured !== '') return []
    const who = deps.identity ?? { name: 'Holi', email: 'holi@localhost' }
    return ['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`]
  }

  /**
   * Fetch, then merge — the inbound half of sync (FR-9, FR-10, FR-12).
   *
   * **Merge, never rebase.** With dozens of unpushed autosave commits a rebase
   * replays each one and can conflict *repeatedly on the same hunk* — a failure
   * mode manufactured entirely by autosave granularity. Merge resolves the
   * divergence once. Non-linear history is the accepted price.
   *
   * (Note it is `git merge`, not `git pull --no-rebase`: fetch and merge are two
   * observable steps, and `git merge` rejects `--no-rebase` outright since a
   * merge is already not a rebase.)
   *
   * **A conflict aborts before this returns.** A conflicted tree holds files
   * full of `<<<<<<<` markers, and autosave would commit them without hesitating.
   * Aborting means the failure is *announced* rather than *inflicted*: ignore the
   * banner and you keep working on an unbroken vault. The conflict is then
   * re-created deliberately, once, when someone chooses to deal with it.
   */
  async function pull(): Promise<PullResult> {
    const target = (await defaultBranch()) ?? 'HEAD'
    await runGit(root, ['fetch', 'origin'], opts)

    const before = await runGit(root, ['rev-parse', 'HEAD'], opts)
    const incoming = await runGit(root, ['rev-list', '--count', `HEAD..origin/${target}`], opts)
    if (incoming === '0') return { kind: 'up-to-date' }

    const merge = await tryGit(root, ['merge', '--no-edit', `origin/${target}`], opts)
    if (!merge.ok) {
      // `--diff-filter=U` is the unmerged set — the paths git could not decide.
      const raw = await runGit(root, ['diff', '--name-only', '--diff-filter=U', '-z'], opts).catch(
        () => '',
      )
      const paths = raw.split('\0').filter((p) => p !== '')
      await abortMerge()
      return { kind: 'conflict', paths }
    }

    const after = await runGit(root, ['rev-parse', 'HEAD'], opts)
    return {
      kind: 'merged',
      commits: Number(await runGit(root, ['rev-list', '--count', `${before}..${after}`], opts)),
    }
  }

  /** FR-20. A no-op when no merge is in progress, so the control can be pressed
   * twice without turning into an error. */
  async function abortMerge(): Promise<void> {
    if (await isMerging()) await runGit(root, ['merge', '--abort'], opts)
  }

  async function commitAll(message: string): Promise<string | null> {
    if (!(await isDirty())) return null
    // `-A` so deletions and untracked files ride along: a deleted note is a
    // change to publish, and a new one is the whole point.
    await runGit(root, ['add', '-A'], opts)
    await runGit(root, [...(await identityArgs()), 'commit', '-m', message], opts)
    return runGit(root, ['rev-parse', 'HEAD'], opts)
  }

  /**
   * `git status --porcelain=v2 --branch -z`, and nothing else.
   *
   * Porcelain v2's `# branch.*` headers carry everything the vault indicator
   * needs, and the entry lines that follow are the dirtiness. `-z` makes the
   * record separator NUL, which matters: a path containing a newline would
   * corrupt a line-based parse, and git will happily track one.
   */
  async function status(): Promise<RepoStatus> {
    const raw = await runGit(
      root,
      ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'],
      opts,
    )

    let branch = ''
    let ahead = 0
    let behind = 0
    let detached = false
    let unborn = false
    let dirty = false

    for (const record of raw.split('\0')) {
      if (record === '') continue
      if (!record.startsWith('# ')) {
        // Any entry at all — changed, untracked or unmerged — means dirty.
        dirty = true
        continue
      }
      const [key, ...rest] = record.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') {
        // A repo with no commits reports the literal `(initial)` here — NOT
        // `(unborn)` in branch.head, which is what it looks like it should do.
        // branch.head still carries the branch name in that state.
        unborn = value === '(initial)'
      } else if (key === 'branch.head') {
        if (value === '(detached)') detached = true
        else branch = value
      } else if (key === 'branch.ab') {
        // Present only when the branch has an upstream. Absent is not a parse
        // failure — it means "nothing to compare against", i.e. zero both ways.
        const [a, b] = value.split(' ')
        ahead = Number(a?.replace('+', '') ?? 0)
        behind = Math.abs(Number(b ?? 0))
      }
    }

    // An unborn or detached HEAD still has a branch name worth reporting, and
    // porcelain does not give one — ask the plumbing directly.
    if (branch === '') {
      branch = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'], opts).catch(() => '')
      if (branch === 'HEAD' || branch === '') {
        branch = (await runGit(root, ['symbolic-ref', '--short', 'HEAD'], opts).catch(() => '')) || branch
      }
    }

    return {
      branch,
      defaultBranch: await defaultBranch(),
      ahead,
      behind,
      dirty,
      merging: await isMerging(),
      detached,
      unborn,
    }
  }

  /** What `origin/HEAD` points at. Null when the remote never published one —
   * a local-only or freshly initialised repo. */
  async function defaultBranch(): Promise<string | null> {
    const ref = await runGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], opts).catch(
      () => null,
    )
    return ref === null ? null : ref.replace(/^origin\//, '')
  }

  /** MERGE_HEAD is git's own record that a merge is underway. Asked via
   * `rev-parse` rather than by stat-ing `.git/MERGE_HEAD`, because `.git` is a
   * file rather than a directory in a worktree or submodule. */
  async function isMerging(): Promise<boolean> {
    const out = await runGit(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], opts).catch(
      () => '',
    )
    return out !== ''
  }

  return { root, status, commitAll, pull }
}
