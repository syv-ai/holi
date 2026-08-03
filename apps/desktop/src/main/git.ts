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
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
  /**
   * Vault-relative paths of everything changed, untracked or unmerged. Empty
   * exactly when `dirty` is false.
   *
   * FR-4's commit message is built from this: `Update <path>` for one file, a
   * count for several. Without it the loop knows only *that* something changed.
   */
  dirtyPaths: string[]
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

export type PushResult =
  | { kind: 'pushed'; commits: number }
  | { kind: 'nothing-to-push' }
  | { kind: 'rejected'; reason: 'permission' | 'non-fast-forward' }

export interface Commit {
  sha: string
  subject: string
  /** ISO 8601, author date. */
  date: string
  author: string
}

export interface GitRepo {
  readonly root: string
  status(): Promise<RepoStatus>
  /** The vault's history — which IS git history (`prd/vaults-sync.md` §History).
   * `path` follows a file through renames. */
  log(opts?: { path?: string; limit?: number }): Promise<Commit[]>
  /** A file's content at a past commit, for the history preview/restore
   * (`prd/vaults-sync.md` §History). Rejects when `path` is absent at `sha` —
   * e.g. a commit from before the file was renamed (`show` reads the given name,
   * it does not `--follow`). */
  show(sha: string, path: string): Promise<string>
  /** The paths a commit changed vs its (first) parent — the file list for a
   * commit's diff view. `--root` so the initial commit lists its files. */
  changedFiles(sha: string): Promise<string[]>
  /** Fetch and merge the default branch. Never rebases; a conflict aborts. */
  pull(): Promise<PullResult>
  /** Re-run the merge WITHOUT aborting, leaving the conflict markers + MERGE_HEAD
   * in the tree for the reconcile flow (`prd/agent.md` §merge resolver). Unlike
   * `pull()`, which announces a conflict by aborting, this re-materialises it so
   * the agent has something to resolve. Re-fetches, so it merges the current
   * remote state, not a stale one. */
  remerge(): Promise<PullResult>
  /** Push local commits to the default branch. The caller recovers from a
   * non-fast-forward rejection by pulling and retrying (`active-vault.ts`
   * §pushNow) — there is no publish combinator, because push is automatic. */
  push(): Promise<PushResult>
  /** FR-20. A no-op when no merge is in progress. */
  abortMerge(): Promise<void>
  /** Stage everything and commit. Returns the new sha, or **null** when the tree
   * was already clean — "nothing to commit" is the normal outcome of an idle
   * timer on an untouched vault, not an error. */
  commitAll(message: string, paths: string[]): Promise<string | null>
}

/**
 * Why a push was refused — or `null` when we genuinely cannot tell.
 *
 * **Returning null matters as much as the two answers.** The caller renders this
 * to the user, and FR-16 is specifically that a permission failure must never be
 * confused with a network or merge failure. The inverse is just as bad: calling
 * a full disk or a DNS failure "you no longer have write access" sends someone
 * to their GitHub settings to fix a problem that is not there. An unrecognised
 * failure stays an unrecognised failure.
 *
 * The permission case is matched on stderr rather than porcelain because a
 * transport-level auth failure kills the push before any ref is negotiated, so
 * there is no porcelain line to read. That is the one documented exception to
 * the "plumbing and porcelain only" rule, and it exists because the information
 * is nowhere else.
 */
export function classifyPushFailure(
  stdout: string,
  stderr: string,
): 'permission' | 'non-fast-forward' | null {
  // GitHub's refusals, verbatim: `remote: Permission to <repo> denied to <user>`
  // with a 403, or `Authentication failed` for a revoked or expired token.
  if (/\bpermission to .+ denied|error: 403|returned error: 403|authentication failed|invalid username or token/i.test(stderr)) {
    return 'permission'
  }
  // A ref git refused because ours is stale. Both spellings land here.
  const refRejected = stdout.split('\n').some((line) => line.startsWith('!'))
  if (refRejected && /non-fast-forward|fetch first|stale info/i.test(stdout)) return 'non-fast-forward'
  return null
}

/**
 * The path field of a `--porcelain=v2 -z` entry: everything after the first `n`
 * space-separated fields.
 *
 * Counted rather than taken from the last space, because git tracks paths with
 * spaces in them and the field counts are fixed per record type: 8 for `1`
 * (ordinary), 9 for `2` (rename/copy — it carries an extra score field), 10 for
 * `u` (unmerged, which lists three stages), 1 for `?` and `!`.
 */
function pathAfter(record: string, n: number): string {
  return record.split(' ').slice(n).join(' ')
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
 * Did this command lose the race for `.git/index.lock`?
 *
 * Worth naming rather than matching inline, because the *caller* has to be able
 * to tell this apart from the failures that share its shape. A merge that
 * cannot take the index reports no unmerged paths, which is indistinguishable
 * from a merge that was refused for any other reason — and calling either one a
 * conflict latches FR-12's sticky pause on a race that will be over in 200 ms.
 */
export function isIndexLockFailure(outcome: { ok: boolean; stderr: string }): boolean {
  return !outcome.ok && INDEX_LOCK.test(outcome.stderr)
}

/** The same question, asked of a `GitError` that was thrown rather than an
 *  outcome that was returned — which is the form it reaches a `catch` in. */
export function isIndexLockError(err: unknown): boolean {
  return err instanceof GitError && INDEX_LOCK.test(err.stderr)
}

const INDEX_LOCK = /index\.lock/

/** Long enough to outlast a commit — measured at ~215 ms on an 800-file vault —
 *  and short enough that a stale lock is reported rather than waited on. */
const LOCK_ATTEMPTS = 5
const LOCK_BACKOFF_MS = 80

/**
 * Run one git command and report how it went without throwing.
 *
 * Failure is an ordinary outcome for several operations here — a merge that
 * conflicts, a push that is rejected — and each carries information in its exit
 * code that an exception would flatten into a message.
 *
 * **Except losing `index.lock`, which is retried rather than reported.** The
 * vault clone is deliberately legible and the agent has `Bash`, so a git the
 * user ran can hold the index while this one wants it — and git itself does not
 * retry, it fails. Measured: `git status` neither takes the lock nor fails on
 * it, so the contended window is only the commit and the merge. Waiting it out
 * here is the direction we control; the reverse direction (our loop failing the
 * user's `git checkout`) is accepted and documented.
 */
export async function tryGit(cwd: string, args: string[], opts: RunOpts = {}): Promise<GitOutcome> {
  for (let attempt = 1; ; attempt++) {
    const outcome = await runGitOnce(cwd, args, opts)
    if (attempt >= LOCK_ATTEMPTS || !isIndexLockFailure(outcome)) return outcome
    await new Promise((resolve) => setTimeout(resolve, LOCK_BACKOFF_MS))
  }
}

async function runGitOnce(cwd: string, args: string[], opts: RunOpts): Promise<GitOutcome> {
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

  /**
   * The reconcile primitive: like `pull()`, but on a conflict it does **not**
   * abort — the conflict markers and MERGE_HEAD are left in the tree so the
   * agent (running inside this state) can resolve them and finish the merge.
   */
  async function remerge(): Promise<PullResult> {
    const target = (await defaultBranch()) ?? 'HEAD'
    await runGit(root, ['fetch', 'origin'], opts)

    const before = await runGit(root, ['rev-parse', 'HEAD'], opts)
    const incoming = await runGit(root, ['rev-list', '--count', `HEAD..origin/${target}`], opts)
    if (incoming === '0') return { kind: 'up-to-date' }

    const merge = await tryGit(root, ['merge', '--no-edit', `origin/${target}`], opts)
    if (!merge.ok) {
      const raw = await runGit(root, ['diff', '--name-only', '--diff-filter=U', '-z'], opts).catch(
        () => '',
      )
      const paths = raw.split('\0').filter((p) => p !== '')
      // No abortMerge() — leave the conflicted tree in place for the reconcile.
      return { kind: 'conflict', paths }
    }

    const after = await runGit(root, ['rev-parse', 'HEAD'], opts)
    return {
      kind: 'merged',
      commits: Number(await runGit(root, ['rev-list', '--count', `${before}..${after}`], opts)),
    }
  }

  /**
   * The file's — or the vault's — history. There is no snapshot store; git's
   * object store is the snapshot store, and autosave commits are what give it
   * resolution.
   *
   * Fields are delimited with **US (0x1f)** and records with NUL, neither of
   * which a human can type into a commit subject. A subject is arbitrary user
   * text, so delimiting on anything typeable — a tab, a pipe — would let a
   * commit message corrupt the parse of the log it appears in.
   */
  async function log(o: { path?: string; limit?: number } = {}): Promise<Commit[]> {
    const args = ['log', '-z', '--format=%H%x1f%s%x1f%aI%x1f%an']
    if (o.limit !== undefined) args.push(`-n${o.limit}`)
    // `--follow` needs exactly one pathspec, and must precede the `--`.
    if (o.path !== undefined) args.push('--follow', '--', o.path)

    // A repo with no commits makes `git log` fail rather than print nothing.
    // That is not an error here: a brand-new vault simply has no history yet.
    const raw = await runGit(root, args, opts).catch(() => '')

    return raw
      .split('\0')
      .filter((record) => record !== '')
      .map((record) => {
        const [sha = '', subject = '', date = '', author = ''] = record.split('\x1f')
        // `-z` leaves a newline between records in some git versions; the sha is
        // fixed-width and leads, so trimming it is enough to normalise.
        return { sha: sha.trim(), subject, date, author }
      })
  }

  /** A file's content at a commit — `git show <sha>:<path>`. The output is the
   * raw blob, not porcelain, so capturing it whole does not break the "parse only
   * plumbing" rule — and unlike `runGit`, this must **not** trim: restore writes
   * the result back verbatim, and a stripped trailing newline is a real edit.
   * Rejects (a `GitError`) when the path does not exist at that commit, which is
   * the signal the caller wants. */
  async function show(sha: string, path: string): Promise<string> {
    const res = await tryGit(root, ['show', `${sha}:${path}`], opts)
    if (!res.ok) {
      throw new GitError(
        `git show ${sha}:${path} failed (${res.code}): ${res.stderr.split('\n')[0] ?? ''}`,
        res.code,
        res.stderr,
      )
    }
    return res.stdout
  }

  /** The paths a commit changed vs its first parent (`--root` so the initial
   * commit lists its files). Plumbing (`diff-tree`), so the newline-separated
   * output is a stable interface. */
  async function changedFiles(sha: string): Promise<string[]> {
    const out = await runGit(
      root,
      ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha],
      opts,
    )
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== '')
  }

  /** FR-20. A no-op when no merge is in progress, so the control can be pressed
   * twice without turning into an error. */
  async function abortMerge(): Promise<void> {
    if (await isMerging()) await runGit(root, ['merge', '--abort'], opts)
  }

  /**
   * The outbound half — and the only thing that leaves the machine (FR-13).
   *
   * `--porcelain` keeps the containment rule: the per-ref result comes back as
   * `<flag>\t<from>:<to>\t<summary>` rather than as the prose git prints for
   * humans. A transport-level auth failure is the one case with no porcelain
   * representation — the push dies before any ref is negotiated — so that is
   * matched on stderr, which is the only place the information exists.
   */
  async function push(): Promise<PushResult> {
    const target = (await defaultBranch()) ?? (await status()).branch
    // A repo created empty (`auto_init: false`, then pushed to) has no
    // `origin/<target>` ref yet, so `origin/<target>..HEAD` *errors* — which
    // means "this branch does not exist upstream", i.e. every local commit is
    // waiting, NOT "nothing to push". Swallowing that error as 0 is what left
    // brand-new vaults silently unpushed and unclonable. Distinguish the two by
    // checking the ref exists before counting against it.
    const hasUpstream = await runGit(
      root,
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target}`],
      opts,
    )
      .then(() => true)
      .catch(() => false)
    const range = hasUpstream ? `origin/${target}..HEAD` : 'HEAD'
    const waiting = Number(await runGit(root, ['rev-list', '--count', range], opts).catch(() => '0'))
    if (waiting === 0) return { kind: 'nothing-to-push' }

    const res = await tryGit(
      root,
      ['push', '--porcelain', 'origin', `HEAD:refs/heads/${target}`],
      opts,
    )
    if (res.ok) return { kind: 'pushed', commits: waiting }

    const reason = classifyPushFailure(res.stdout, res.stderr)
    if (reason !== null) return { kind: 'rejected', reason }
    // Unrecognised: surface it as the error it is rather than inventing a
    // reason. A wrong diagnosis here sends someone to fix the wrong thing.
    throw new GitError(
      `git push failed (${res.code}): ${res.stderr.split('\n')[0] ?? ''}`,
      res.code,
      res.stderr,
    )
  }

  async function commitAll(message: string, paths: string[]): Promise<string | null> {
    // The caller decides what commits (the large-file gate holds oversized files
    // out by simply not naming them); an empty pathspec is the idle/all-held-back
    // path, nothing to do.
    if (paths.length === 0) return null
    // `-A -- <paths>` so deletions and untracked files among the named paths ride
    // along — a deleted note is a change to publish, a new one is the point — but
    // only those paths, never the whole tree.
    await runGit(root, ['add', '-A', '--', ...paths], opts)
    // Nothing actually got staged (e.g. the named paths were already clean): not
    // an error, just the idle path — do not create an empty commit.
    if ((await tryGit(root, ['diff', '--cached', '--quiet'], opts)).ok) return null
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
    const dirtyPaths: string[] = []

    const records = raw.split('\0')
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!
      if (record === '') continue
      if (!record.startsWith('# ')) {
        // Any entry at all — changed, untracked or unmerged — means dirty.
        //
        // The path is the remainder after a fixed number of space-separated
        // fields, counted rather than found by the last space: git tracks paths
        // containing spaces and a `lastIndexOf(' ')` would truncate them.
        const kind = record[0]
        if (kind === '1') dirtyPaths.push(pathAfter(record, 8))
        else if (kind === '2') {
          dirtyPaths.push(pathAfter(record, 9))
          // A rename's ORIGINAL path is a second NUL-separated field belonging
          // to this same record. Consume it, or the next loop reads it as an
          // entry of its own and reports a file that is not dirty at all.
          i++
        } else if (kind === 'u') dirtyPaths.push(pathAfter(record, 10))
        else if (kind === '?') dirtyPaths.push(pathAfter(record, 1))
        // `!` (ignored) cannot appear without --ignored, and must never count
        // as dirty if it ever did — that is what .gitignore is for.
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
      dirty: dirtyPaths.length > 0,
      dirtyPaths,
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

  return { root, status, log, show, changedFiles, commitAll, pull, remerge, push, abortMerge }
}

/**
 * `owner/repo` -> the HTTPS URL git clones from.
 *
 * Owned here so no caller ever hand-builds one — which is how a token ends up
 * embedded in a remote URL and then persisted into `.git/config`. The credential
 * arrives via GIT_ASKPASS instead, and this URL stays clean enough to show a
 * user or paste into a terminal.
 */
export function remoteUrl(remote: string): string {
  return `https://github.com/${remote}.git`
}

/**
 * Clone a vault.
 *
 * `url` rather than `owner/repo` so tests can point at a local bare repo;
 * production callers pass `remoteUrl(remote)`. The Holi-managed root that
 * `dest` lives under is the registry's business, not this module's (FR-1).
 */
export async function cloneRepo(
  args: { url: string; dest: string },
  deps: GitDeps = {},
): Promise<GitRepo> {
  const { url, dest } = args

  // Refuse rather than clobber: the directory may hold unpublished commits, and
  // git's own "destination path already exists and is not an empty directory"
  // arrives only after it has begun. Checking first keeps the message ours.
  const existing = await readdir(dest).catch(() => null)
  if (existing !== null && existing.length > 0) {
    throw new Error(`${dest} is not empty — refusing to clone over it`)
  }

  await mkdir(dirname(dest), { recursive: true })
  // Run from the parent: `dest` may not exist yet, and cwd must.
  await runGit(dirname(dest), ['clone', url, dest], {
    token: deps.token,
    gitPath: deps.gitPath,
    env: deps.env,
  })
  return openRepo(dest, deps)
}
