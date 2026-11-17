/**
 * The git engine: Holi's sync, run against the system `git` binary.
 *
 * **Why the binary and not a JS implementation** (`docs/features/vaults-sync.md`):
 * the whole reconcile path rests on git *refusing* a merge rather than guessing,
 * which is isomorphic-git's weakest area. Shelling out also inherits credential
 * helpers, hooks and `.gitignore` semantics, and behaves like the terminal the
 * user and agent end up in when a merge goes wrong.
 *
 * **The rule that contains the cost:** parse only plumbing commands and
 * `--porcelain=v2`. Human-readable output is not a stable interface.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  MEMORY_INDEX,
  appBundleOf,
  isAppDataPath,
  isSharedMemoryPath,
  shownPathOrNull,
} from '@holi/shared'
import { writeMemoryIndex } from './vault/hooks/memory-index'

/**
 * A git command that ran and failed.
 * @public exported for its test
 */
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
 * advice (install git), not a stack trace.
 * @public exported for its test
 */
export class GitMissingError extends Error {
  constructor(readonly gitPath: string) {
    super(`\`${gitPath}\` was not found. Holi needs the git command-line tool installed.`)
    this.name = 'GitMissingError'
  }
}

/** A bounded historical read could not complete within its fixed resource budget. */
class GitResourceError extends Error {
  constructor(readonly kind: 'time' | 'output') {
    super(`Historical Git read exceeded its ${kind === 'time' ? 'time' : 'output'} resource limit.`)
    this.name = 'GitResourceError'
  }
}

class GitHistoricalObjectError extends Error {
  constructor() {
    super('Historical Git endpoint must be a full commit or tree object id.')
    this.name = 'GitHistoricalObjectError'
  }
}

export class GitHistoricalPathMissingError extends Error {
  constructor() {
    super('The path is not present at this historical object.')
    this.name = 'GitHistoricalPathMissingError'
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
  /** Optional machine-local recorder used only by managed vault commits. */
  commitProvenance?: {
    begin(root: string): Promise<unknown> | unknown
    record(ticket: unknown, root: string, oid: string | null): Promise<void>
  }
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
 * **Why a shell script and not node.** Git for Windows supplies the `sh.exe`
 * interpreter used for askpass scripts, while POSIX systems provide `/bin/sh`.
 * A `#!/usr/bin/env node` shebang would instead depend on Node being on PATH,
 * which is not a given in a packaged Electron app.
 *
 * The directory comes from `mkdtemp`, so it is 0700 and unpredictable — no other
 * user can pre-create the path and have git execute their script instead.
 */
let askpassPromise: Promise<string> | null = null

/** @public exported for its test */
export function askpassScript(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') {
    return '#!/bin/sh\ncase "$1" in *sername*) echo "x-access-token";; *) echo "$HOLI_GIT_TOKEN";; esac\n'
  }
  // Git for Windows provides sh.exe and runs shebang scripts, avoiding CMD's
  // unsafe interpolation of the prompt argument into batch syntax.
  return '#!/bin/sh\ncase "$1" in [Uu][Ss][Ee][Rr][Nn][Aa][Mm][Ee]*) echo "x-access-token";; *) printf "%s\\n" "$HOLI_GIT_TOKEN";; esac\n'
}

/** @public exported for its test */
export function ensureAskpass(): Promise<string> {
  askpassPromise ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-git-'))
    const file = join(dir, 'askpass.sh')
    await writeFile(file, askpassScript(), { mode: 0o700 })
    return file
  })()
  return askpassPromise
}

export interface RunOpts extends Pick<GitDeps, 'token' | 'gitPath' | 'env'> {
  /**
   * Written to the command's stdin, which is then closed. For commands that take
   * a path list (`check-ignore`): thousands of paths as arguments hit `E2BIG`.
   */
  input?: string
  /** Limits for historical reads consumed by an agent turn; absent for ordinary git work. */
  executionBudget?: { maxBuffer: number; timeout: number }
}

export interface RepoStatus {
  branch: string
  /** `origin/HEAD`'s target, or null when the remote has none. Informational:
   * sync follows the checked-out branch, not this one. */
  defaultBranch: string | null
  ahead: number
  behind: number
  dirty: boolean
  /**
   * Vault-relative paths of everything changed, untracked or unmerged. Empty
   * exactly when `dirty` is false. The autosave commit message is built from it.
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
  /** `from` and `to` are HEAD before and after: what the merge brought in is
   *  the difference between them. */
  | { kind: 'merged'; commits: number; from: string; to: string }
  | {
      kind: 'conflict'
      paths: string[]
      /** A merge refused before it started names no paths; these are the
       *  uncommitted files here that the incoming side changed, the ones in
       *  its way. Empty when the refusal was something else. */
      overwrites?: string[]
    }

type PushResult =
  | { kind: 'pushed'; commits: number; branch: string }
  | { kind: 'nothing-to-push' }
  | { kind: 'rejected'; reason: 'permission' | 'non-fast-forward' }

export interface Commit {
  sha: string
  subject: string
  /** ISO 8601, author date. */
  date: string
  author: string
  /** Lines added across the commit, summed over its files, or over the ONE
   *  file when `log` was given a path. */
  added: number
  removed: number
}

/** One file's change across a commit range — the unit an agent turn is reviewed
 *  in. */
export interface RangeFile {
  path: string
  added: number
  removed: number
  /** `A` | `M` | `D` | `R<score>`. A rename reports its NEW path. */
  status: string
}

/** The vault's branches, for the status bar's branch picker. */
export interface BranchList {
  /** The checked-out branch, or null on a detached HEAD. */
  current: string | null
  /** Local branches, most recently committed first. */
  local: { name: string; upstream: string | null }[]
  /** Branches on `origin` that have no local branch of the same name, most
   *  recently committed first. Named without the `origin/` prefix. */
  remote: { name: string }[]
}

/** A branch switch or creation git or Holi would not do, in words for the
 *  person who asked. */
export class BranchRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BranchRefusedError'
  }
}

export interface GitRepo {
  readonly root: string
  status(): Promise<RepoStatus>
  /** The current commit, or **null** on an unborn branch (no commits yet): a
   *  real state of a real vault, not an error. */
  head(): Promise<string | null>
  /** The paths changed across `from..to`, with line counts. Missing or invalid
   *  history is empty; an exhausted execution budget throws GitResourceError. */
  rangeFiles(
    from: string,
    to: string,
    executionBudget?: { maxBuffer: number; timeout: number },
  ): Promise<RangeFile[]>
  /** The vault's history — which IS git history (`features/history.md`).
   * `path` follows a file through renames; a `folder` is every commit under it,
   * which `--follow` (one file only) cannot walk. */
  log(opts?: { path?: string; folder?: boolean; limit?: number }): Promise<Commit[]>
  /** Bounded reachable commit/path changes between exact endpoints. */
  revisionChanges(
    from: string,
    to: string,
    path: string,
  ): Promise<{
    complete: boolean
    reason: 'ok' | 'history-unavailable' | 'limit'
    changes: { sha: string; path: string }[]
  }>
  /** A file's content at a past commit, for the history preview/restore
   * (`features/history.md`). Rejects when `path` is absent at `sha` —
   * e.g. a commit from before the file was renamed (`show` reads the given name,
   * it does not `--follow`). A budgeted read throws typed historical-object,
   * missing-path and resource errors. */
  show(
    sha: string,
    path: string,
    executionBudget?: { maxBuffer: number; timeout: number },
  ): Promise<string>
  /** One commit's exact metadata and churn, even when it is outside a recent
   * history listing. Null when the object is unavailable. */
  commit(sha: string): Promise<Commit | null>
  /** The paths a commit changed vs its (first) parent — the file list for a
   * commit's diff view. `--root` so the initial commit lists its files. */
  changedFiles(sha: string): Promise<string[]>
  /** The paths each of the last `limit` commits changed, newest first: the
   *  vault-wide history's file lists in one call rather than one per commit. */
  commitFiles(limit: number): Promise<{ sha: string; files: string[] }[]>
  /** Fetch and merge the checked-out branch's namesake on `origin`. Never
   *  rebases; a conflict aborts. */
  pull(): Promise<PullResult>
  /** Re-run the merge WITHOUT aborting, leaving the conflict markers + MERGE_HEAD
   * in the tree for the reconcile flow (`features/agent-sessions.md`). Unlike
   * `pull()`, which announces a conflict by aborting, this re-materialises it so
   * the agent has something to resolve. Re-fetches, so it merges the current
   * remote state, not a stale one. */
  remerge(): Promise<PullResult>
  /** Push local commits to the checked-out branch's namesake on `origin`,
   * setting the upstream on a branch's first push. The caller recovers from a
   * non-fast-forward rejection by pulling and retrying (`active-vault.ts`
   * `pushNow`). */
  push(): Promise<PushResult>
  /** A no-op when no merge is in progress. */
  abortMerge(): Promise<void>
  /** Stage everything and commit. Returns the new sha, or **null** when the tree
   * was already clean — "nothing to commit" is the normal outcome of an idle
   * timer on an untouched vault, not an error. */
  commitAll(message: string, paths: string[]): Promise<string | null>
  /** "Commit anyway" for a held-back file: stage this one path and commit it with
   *  `--no-verify` (the deliberate large-file hook bypass). Null if not dirty. */
  commitFileNoVerify(path: string): Promise<string | null>
  /** Local and remote branches (`for-each-ref`, nothing fetched). */
  branches(): Promise<BranchList>
  /** `git fetch origin`: the refs the branch picker lists. */
  fetch(): Promise<void>
  /**
   * Check out `name`: a local branch, or a branch only on `origin`, which gets
   * a local branch tracking it. `create` makes a new branch at HEAD instead.
   * Refuses (`BranchRefusedError`) a dirty tree, a merge in progress and an
   * invalid name; the caller settles the tree first.
   */
  switchBranch(name: string, opts?: { create?: boolean }): Promise<void>
  /** "Keep local" for a held-back file: append it to `.git/info/exclude`, git's
   *  machine-local ignore — the file stays on disk but stops being dirty/synced. */
  excludeLocally(path: string): Promise<void>
}

/**
 * Why a push was refused, or `null` when we genuinely cannot tell.
 *
 * **Returning null matters as much as the two answers.** A permission failure
 * must never be confused with a network or merge failure, and the inverse
 * (calling a full disk "you no longer have write access") sends someone to fix
 * a problem that is not there.
 *
 * The permission case is matched on stderr because a transport-level auth
 * failure kills the push before any ref is negotiated, so there is no porcelain
 * line to read: the one exception to the "plumbing and porcelain only" rule.
 * @public exported for its test
 */
export function classifyPushFailure(
  stdout: string,
  stderr: string,
): 'permission' | 'non-fast-forward' | null {
  // GitHub's refusals, verbatim: `remote: Permission to <repo> denied to <user>`
  // with a 403, or `Authentication failed` for a revoked or expired token.
  if (
    /\bpermission to .+ denied|error: 403|returned error: 403|authentication failed|invalid username or token/i.test(
      stderr,
    )
  ) {
    return 'permission'
  }
  // A ref git refused because ours is stale. Both spellings land here.
  const refRejected = stdout.split('\n').some((line) => line.startsWith('!'))
  if (refRejected && /non-fast-forward|fetch first|stale info/i.test(stdout))
    return 'non-fast-forward'
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

function isMissingObject(stderr: string): boolean {
  return /could not get object info|not a valid object name|bad object|path .* does not exist in|path .* exists on disk, but not in/i.test(
    stderr,
  )
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
 * The caller must tell this apart from failures of the same shape: a merge that
 * cannot take the index reports no unmerged paths, and calling it a conflict
 * latches the sticky sync pause on a race that will be over in 200 ms.
 */
function isIndexLockFailure(outcome: { ok: boolean; stderr: string }): boolean {
  return !outcome.ok && INDEX_LOCK.test(outcome.stderr)
}

/** The same question, asked of a thrown `GitError`. */
export function isIndexLockError(err: unknown): boolean {
  return err instanceof GitError && INDEX_LOCK.test(err.stderr)
}

const INDEX_LOCK = /index\.lock/

/** Long enough to outlast a commit (~215 ms on an 800-file vault) and short
 *  enough that a stale lock is reported rather than waited on. */
const LOCK_ATTEMPTS = 5
const LOCK_BACKOFF_MS = 80

/**
 * Run one git command and report how it went without throwing. Failure is an
 * ordinary outcome here (a conflicting merge, a rejected push) and its exit code
 * carries information an exception would flatten.
 *
 * **Except losing `index.lock`, which is retried rather than reported.** The
 * user's or the agent's own git can hold the index, and git does not retry.
 * `git status` neither takes the lock nor fails on it, so the contended window
 * is only the commit and the merge. The reverse direction (our loop failing the
 * user's `git checkout`) is accepted.
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
  const token = opts.token?.() ?? ''
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: askpass,
    HOLI_GIT_TOKEN: token,
    LC_ALL: 'C',
    ...opts.env,
  }
  if (WINDOWS) {
    for (const key of [
      'GIT_TERMINAL_PROMPT',
      'GIT_ASKPASS',
      'HOLI_GIT_TOKEN',
      'LC_ALL',
      'GCM_INTERACTIVE',
    ]) {
      for (const existing of Object.keys(env)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete env[existing]
      }
    }
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: askpass,
      HOLI_GIT_TOKEN: token,
      LC_ALL: 'C',
      GCM_INTERACTIVE: 'never',
    })
  }
  return new Promise((resolve, reject) => {
    let expired = false
    let outputExceeded = false
    let outputBytes = 0
    let killTimer: NodeJS.Timeout | undefined
    const budgetTimer =
      opts.executionBudget === undefined
        ? undefined
        : setTimeout(() => {
            expired = true
            child.kill('SIGTERM')
            killTimer = setTimeout(() => child.kill('SIGKILL'), 100)
          }, opts.executionBudget.timeout)
    const child = execFile(
      gitPath,
      args,
      {
        cwd,
        maxBuffer: opts.executionBudget?.maxBuffer ?? MAX_BUFFER,
        env,
      },
      (err, stdout, stderr) => {
        if (budgetTimer !== undefined) clearTimeout(budgetTimer)
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (outputExceeded) return reject(new GitResourceError('output'))
        if (expired) return reject(new GitResourceError('time'))
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new GitMissingError(gitPath))
        }
        if (err && opts.executionBudget !== undefined) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
            return reject(new GitResourceError('output'))
        }
        const code = err ? ((err as { code?: number }).code ?? 1) : 0
        resolve({ ok: !err, code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
    if (opts.executionBudget !== undefined) {
      const accountOutput = (chunk: Buffer): void => {
        outputBytes += Buffer.byteLength(String(chunk))
        if (outputExceeded || outputBytes <= opts.executionBudget!.maxBuffer) return
        outputExceeded = true
        clearTimeout(budgetTimer)
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), 100)
      }
      child.stdout?.on('data', accountOutput)
      child.stderr?.on('data', accountOutput)
    }
    if (opts.input !== undefined) {
      // EPIPE is normal here, not a failure: git may exit before reading all of
      // it (`check-ignore` stops at a bad pathspec). The callback above still
      // fires with the real exit code, which is the answer that matters.
      child.stdin?.on('error', () => {})
      child.stdin?.end(opts.input)
    }
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
   * Identity flags for a commit, **only** when the machine has none.
   *
   * `-c user.email=…` overrides rather than defaults, so passing it
   * unconditionally would author every commit as Holi. But a machine with no
   * configured identity cannot commit at all, so fill in only the gap.
   */
  async function identityArgs(): Promise<string[]> {
    const configured = await runGit(root, ['config', '--get', 'user.email'], opts).catch(() => '')
    if (configured !== '') return []
    const who = deps.identity ?? { name: 'Holi', email: 'holi@localhost' }
    return ['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`]
  }

  /**
   * Fetch, then merge: the inbound half of sync.
   *
   * **Merge, never rebase.** With dozens of unpushed autosave commits a rebase
   * replays each one and can conflict *repeatedly on the same hunk*. Merge
   * resolves the divergence once; non-linear history is the accepted price.
   *
   * **A conflict aborts before this returns.** Autosave would otherwise commit
   * files full of `<<<<<<<` markers. Aborting means the failure is announced
   * rather than inflicted; `remerge` re-creates it when someone chooses to deal
   * with it.
   */
  async function pull(): Promise<PullResult> {
    return mergeRemote({ abortOnConflict: true })
  }

  /**
   * The reconcile primitive: like `pull()`, but on a conflict it does **not**
   * abort — the conflict markers and MERGE_HEAD are left in the tree so the
   * agent (running inside this state) can resolve them and finish the merge.
   */
  async function remerge(): Promise<PullResult> {
    return mergeRemote({ abortOnConflict: false })
  }

  async function mergeRemote({
    abortOnConflict,
  }: {
    abortOnConflict: boolean
  }): Promise<PullResult> {
    await runGit(root, ['fetch', 'origin'], opts)
    const target = await remoteTarget()
    // A branch never pushed has nothing on `origin` to merge yet.
    if (target === null) return { kind: 'up-to-date' }

    const before = await runGit(root, ['rev-parse', 'HEAD'], opts)
    const incoming = await runGit(root, ['rev-list', '--count', `HEAD..${target}`], opts)
    if (incoming === '0') return { kind: 'up-to-date' }

    const merge = await tryGit(root, ['merge', '--no-edit', target], opts)
    if (!merge.ok) {
      if (!(await isMerging())) {
        // Refused before it started: git names no unmerged paths, only the
        // uncommitted ones in its way, which are the incoming side's changes
        // that are dirty here.
        return { kind: 'conflict', paths: [], overwrites: await dirtyIncoming(target) }
      }
      // A settlement that throws must not leave markers and MERGE_HEAD behind
      // for autosave to commit: a pull aborts, as it does on a conflict.
      const paths = await settleOneAnswerConflicts().catch(async (err: unknown) => {
        if (abortOnConflict) await abortMerge()
        throw err
      })
      if (paths.length > 0) {
        if (abortOnConflict) await abortMerge()
        // Left in the tree for the reconcile otherwise.
        return { kind: 'conflict', paths }
      }
      // Every conflict had one answer and was settled: the merge is whole,
      // and committed as `git merge` commits one it finishes itself, with no
      // pre-commit hook. Its changes were committed on both sides already,
      // and the hook would hold this merge alone to a gate (large files) the
      // clean ones skip. The transforms would not undo the settlement: relink
      // deletes no kept file (`followNoteComments`), and memory-index writes
      // the index this merge just wrote.
      await runGit(root, [...(await identityArgs()), 'commit', '--no-verify', '--no-edit'], opts)
    }

    const after = await runGit(root, ['rev-parse', 'HEAD'], opts)
    return {
      kind: 'merged',
      commits: Number(await runGit(root, ['rev-list', '--count', `${before}..${after}`], opts)),
      from: before,
      to: after,
    }
  }

  /**
   * Settle what a merge left unmerged that has only one answer, and return
   * the paths still unmerged (`--diff-filter=U`, the paths git could not
   * decide).
   *
   * Two kinds have one answer (docs/features/vaults-sync.md):
   *
   *   - **A file changed on one side and deleted on the other keeps the
   *     change.** Deleting it would lose work; keeping it loses nothing, since
   *     whoever deleted it can delete it again. A modify/delete never reaches
   *     a merge driver, so this is also how a note's comment sidecar survives
   *     its note being deleted (docs/features/note-comments.md). The changed
   *     side is staged as it is in the tree, which is where git left it.
   *     Which paths qualify is `keepsChangeOverDelete`.
   *   - **`.holi/memory/index.md` is generated**, so whatever both sides did to
   *     it, the index the merged tree's memories make is the answer. It is
   *     written after the kept files are staged, so a kept memory is listed.
   */
  async function settleOneAnswerConflicts(): Promise<string[]> {
    const stages = await unmergedStages()
    const keep: string[] = []
    for (const [path, s] of stages) {
      if (keepsChangeOverDelete(path, s) && (await isFileInTree(path))) keep.push(path)
    }
    if (keep.length > 0) await runGit(root, ['add', '--', ...keep], opts)
    // Read from the tree, so only once no memory there still holds markers;
    // otherwise the index stays a conflict, and the commit that resolves the
    // memory rebuilds it through the transform.
    const memoryStillUnmerged = [...stages.keys()].some(
      (p) => p !== MEMORY_INDEX && isSharedMemoryPath(p) && !keep.includes(p),
    )
    if (stages.has(MEMORY_INDEX) && !memoryStillUnmerged) {
      // A dirty shared memory may be held back by the large-file gate. It is
      // not part of the merge's staged tree, so indexing the worktree here
      // would commit metadata for an edit that this merge must leave behind.
      const unstaged = await runGit(root, ['diff', '--name-only', '-z'], opts)
      const untracked = await runGit(
        root,
        ['ls-files', '--others', '--exclude-standard', '-z'],
        opts,
      )
      const heldBackMemory = `${unstaged}${untracked}`
        .split('\0')
        .some((path) => path !== '' && isSharedMemoryPath(path) && !stages.has(path))
      if (!heldBackMemory) {
        await writeMemoryIndex(root)
        await runGit(root, ['add', '--', MEMORY_INDEX], opts)
      }
    }
    const raw = await runGit(root, ['diff', '--name-only', '--diff-filter=U', '-z'], opts).catch(
      () => '',
    )
    return raw.split('\0').filter((p) => p !== '')
  }

  /**
   * Whether a path one side changed and the other deleted keeps the change:
   * stage 1 (base) and exactly one of 2 (ours) and 3 (theirs). Not the
   * generated index, which is rebuilt instead, and not a vault app's record,
   * whose deletion is a deliberate act its store made: that goes to reconcile
   * (docs/features/vault-apps.md).
   */
  function keepsChangeOverDelete(path: string, stages: Set<string>): boolean {
    if (path === MEMORY_INDEX) return false
    const bundle = appBundleOf(path)
    if (bundle !== null && isAppDataPath(path.slice(bundle.length + 1))) return false
    return stages.has('1') && stages.has('2') !== stages.has('3')
  }

  /** A file (or link) git left at the path itself. A directory/file conflict
   *  moves the file aside to `path~<side>`, which staging the bare path would
   *  not keep, so that one stays a conflict for reconcile. */
  async function isFileInTree(path: string): Promise<boolean> {
    const s = await lstat(join(root, path)).catch(() => null)
    return s !== null && (s.isFile() || s.isSymbolicLink())
  }

  /** The uncommitted paths here that the incoming side changed: what makes
   *  `git merge` refuse before it starts. */
  async function dirtyIncoming(target: string): Promise<string[]> {
    const raw = await runGit(
      root,
      ['diff', '--name-only', '--no-renames', '-z', `HEAD...${target}`],
      opts,
    ).catch(() => '')
    const incoming = new Set(raw.split('\0').filter((p) => p !== ''))
    const dirty = await status()
      .then((s) => s.dirtyPaths)
      .catch(() => [])
    return dirty.filter((p) => incoming.has(p))
  }

  async function unmergedStages(): Promise<Map<string, Set<string>>> {
    const unmerged = await runGit(root, ['ls-files', '-u', '-z'], opts).catch(() => '')
    // `<mode> <sha> <stage>\t<path>`: stage 1 base, 2 ours, 3 theirs.
    const stages = new Map<string, Set<string>>()
    for (const entry of unmerged.split('\0').filter((e) => e !== '')) {
      const tab = entry.indexOf('\t')
      const path = entry.slice(tab + 1)
      const stage = entry.slice(0, tab).split(' ')[2] ?? ''
      stages.set(path, (stages.get(path) ?? new Set()).add(stage))
    }
    return stages
  }

  /**
   * The file's, or the vault's, history. Git's object store is the snapshot
   * store, and autosave commits give it resolution.
   *
   * Fields are delimited with **US (0x1f)**, which nobody types into a commit
   * subject, so a commit message cannot corrupt the parse.
   */
  async function log(
    o: { path?: string; folder?: boolean; limit?: number } = {},
  ): Promise<Commit[]> {
    // **RS (0x1e) leads each record, rather than `-z` separating them.**
    // `--numstat` writes its own newline-separated lines after each commit, and
    // under `-z` it NUL-terminates paths as well — so the record separator and
    // the payload would be the same byte. A leading RS keeps one unambiguous
    // record boundary, and `%s` is the subject's FIRST line by definition, so
    // no field inside a record can contain a newline either.
    // `--literal-pathspecs`: the path is a name, never a glob. Without it
    // `memor?/x.md` or `*x.md` would match a file the caller never named, and
    // a vault app asking for one path's history would get another's.
    const args = ['--literal-pathspecs', 'log', '--numstat', '--format=%x1e%H%x1f%s%x1f%aI%x1f%an']
    if (o.limit !== undefined) args.push(`-n${o.limit}`)
    // `--follow` needs exactly one pathspec, and must precede the `--`.
    // `--raw` beside it, for the status letter that tells a copy from a rename.
    // A folder is every commit under it, unfollowed.
    if (o.path !== undefined && o.folder === true) args.push('--', o.path)
    else if (o.path !== undefined) args.push('--raw', '--follow', '--', o.path)

    // A repo with no commits makes `git log` fail rather than print nothing.
    // That is not an error here: a brand-new vault simply has no history yet.
    const raw = await runGit(root, args, opts).catch(() => '')

    const commits = raw
      .split('\x1e')
      .filter((record) => record.trim() !== '')
      .map((record) => {
        const [header = '', ...lines] = record.split('\n')
        const [sha = '', subject = '', date = '', author = ''] = header.split('\x1f')
        // `--raw` lines lead with `:` and carry the status: `C055` is a copy.
        const raws = lines.filter((line) => line.startsWith(':'))
        const stats = lines.filter((line) => !line.startsWith(':'))
        const copied = raws.some((line) => line.split('\t')[0]?.split(' ').at(-1)?.startsWith('C'))

        // `<added>\t<removed>\t<path>`. The path is deliberately not read: it
        // is the one field git may quote, and the counts are all this needs.
        // A BINARY file reports `-` for both, which `Number` makes NaN and `||`
        // makes 0: an image has no lines.
        let added = 0
        let removed = 0
        for (const line of stats) {
          const [a, r] = line.split('\t')
          if (a === undefined || r === undefined) continue
          added += Number(a) || 0
          removed += Number(r) || 0
        }

        return { commit: { sha: sha.trim(), subject, date, author, added, removed }, copied }
      })

    /**
     * **A copy is a birth, not a rename.** `--follow` walks copies as well, and
     * two small files with the same frontmatter (every new task) are similar
     * enough for git to call one a copy of the other, so a new file inherited
     * an older one's commits. A rename leaves no source behind and is followed;
     * at a copy the file's own history starts, and the log stops there.
     */
    const birth = commits.findIndex((c) => c.copied)
    return (birth === -1 ? commits : commits.slice(0, birth + 1)).map((c) => c.commit)
  }

  async function revisionChanges(from: string, to: string, path: string) {
    const incomplete = (reason: 'history-unavailable' | 'limit') => ({
      complete: false,
      reason,
      changes: [] as { sha: string; path: string }[],
    })
    if (
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(from) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(to)
    )
      return incomplete('history-unavailable')
    const started = Date.now()
    const deadline = started + 5000
    const outputLimit = 8 * 1024 * 1024
    let outputBytes = 0
    const git = async (args: string[], maxOutput = outputLimit): Promise<GitOutcome> => {
      const timeout = deadline - Date.now()
      const remainingOutput = outputLimit - outputBytes
      if (timeout <= 0) throw new GitResourceError('time')
      if (remainingOutput <= 0) throw new GitResourceError('output')
      const result = await runGitOnce(
        root,
        ['--no-replace-objects', '--literal-pathspecs', ...args],
        {
          ...opts,
          env: {
            ...opts.env,
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_NO_LAZY_FETCH: '1',
            GIT_TERMINAL_PROMPT: '0',
          },
          executionBudget: {
            maxBuffer: Math.min(remainingOutput, maxOutput),
            timeout,
          },
        },
      )
      outputBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)
      return result
    }
    try {
      const base = await git(['cat-file', '-e', `${from}^{commit}`])
      const tip = await git(['cat-file', '-e', `${to}^{commit}`])
      const shallow = await git(['rev-parse', '--is-shallow-repository'])
      if (!base.ok || !tip.ok || !shallow.ok || shallow.stdout.trim() !== 'false')
        return incomplete('history-unavailable')
      const ancestry = await git(['merge-base', '--is-ancestor', from, to])
      if (!ancestry.ok) return incomplete('history-unavailable')
      // 201 distinguishes exactly-at-limit from over-limit without walking an
      // unbounded history. The output limit is cumulative across every command.
      const list = await git(['rev-list', '--topo-order', '--max-count=201', to, `^${from}`])
      if (!list.ok) return incomplete('history-unavailable')
      const commits = list.stdout.split(/\r?\n/).filter(Boolean)
      if (commits.length > 200) return incomplete('limit')
      const changes: { sha: string; path: string }[] = []
      const baseArgs = [
        'diff-tree',
        '--no-commit-id',
        '--raw',
        '-z',
        '--no-renames',
        '--no-ext-diff',
        '-m',
        '-r',
        '--root',
      ]
      for (const sha of commits) {
        const args = [...baseArgs, sha]
        // An empty scope means the entire tree. Do not pass an empty pathspec,
        // which Git interprets as a literal empty filename.
        if (path !== '') args.push('--', path)
        const result = await git(args)
        if (!result.ok) return incomplete('history-unavailable')
        // Raw records retain both modes without reading blobs. Exclude a path if
        // either historical side is a symlink or gitlink, even when absent now.
        const records = result.stdout.split('\0')
        const changedPaths = new Set<string>()
        for (let i = 0; i < records.length;) {
          const header = records[i++]
          if (!header) continue
          const fields = header.trimStart().split(/\s+/)
          const oldMode = fields[0]?.slice(1)
          const newMode = fields[1]
          const changed = records[i++]
          if (!changed) break
          if (
            oldMode === '120000' ||
            newMode === '120000' ||
            oldMode === '160000' ||
            newMode === '160000'
          )
            continue
          changedPaths.add(changed)
        }
        for (const changed of changedPaths) {
          changes.push({ sha, path: changed })
          if (changes.length > 2000) return incomplete('limit')
        }
      }
      return { complete: true, reason: 'ok' as const, changes }
    } catch (error) {
      if (error instanceof GitResourceError) return incomplete('limit')
      // Git may disappear, fail to spawn, or encounter a corrupt/missing object
      // between validation and traversal. None of these is an empty history.
      return incomplete('history-unavailable')
    }
  }

  /** A file's content at a commit. Unlike `runGit`, this must **not** trim:
   * restore writes the result back verbatim, and a stripped trailing newline is
   * a real edit. A budgeted read throws typed historical-object, missing-path
   * and resource errors. */
  async function show(
    sha: string,
    path: string,
    executionBudget?: { maxBuffer: number; timeout: number },
  ): Promise<string> {
    const readOpts = { ...opts, ...(executionBudget === undefined ? {} : { executionBudget }) }
    if (executionBudget !== undefined) {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) throw new GitHistoricalObjectError()
      const endpoint = await tryGit(root, ['cat-file', '-t', sha], readOpts)
      if (!endpoint.ok) {
        if (isMissingObject(endpoint.stderr)) return ''
        throw new GitError(
          `git cat-file failed (${endpoint.code}): ${endpoint.stderr}`,
          endpoint.code,
          endpoint.stderr,
        )
      }
      if (!['commit', 'tree'].includes(endpoint.stdout.trim())) throw new GitHistoricalObjectError()
      const pathType = await tryGit(root, ['cat-file', '-t', `${sha}:${path}`], readOpts)
      if (!pathType.ok) {
        if (isMissingObject(pathType.stderr)) throw new GitHistoricalPathMissingError()
        throw new GitError(
          `git cat-file failed (${pathType.code}): ${pathType.stderr}`,
          pathType.code,
          pathType.stderr,
        )
      }
      // A path that resolves to a tree is a directory, not a file-side value.
      if (pathType.stdout.trim() !== 'blob') throw new GitHistoricalPathMissingError()
    }
    const res = await tryGit(root, ['show', '--end-of-options', `${sha}:${path}`], readOpts)
    if (!res.ok) {
      throw new GitError(
        `git show ${sha}:${path} failed (${res.code}): ${res.stderr.split('\n')[0] ?? ''}`,
        res.code,
        res.stderr,
      )
    }
    return res.stdout
  }

  async function commit(sha: string): Promise<Commit | null> {
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw new Error('Invalid commit SHA')
    // Resolve the input specifically as a commit. Git rejects ambiguous
    // abbreviations here; peeling also refuses blobs and trees. Passing only
    // validated hex keeps the revision expression out of option injection.
    const resolved = await tryGit(
      root,
      ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`],
      opts,
    )
    if (!resolved.ok || !/^[0-9a-f]{40,64}$/i.test(resolved.stdout.trim())) return null
    const fullSha = resolved.stdout.trim()
    const raw = await runGit(
      root,
      ['log', '--no-walk', '--numstat', '--format=%H%x1f%s%x1f%aI%x1f%an', fullSha],
      opts,
    )
    const [header = '', ...stats] = raw.split('\n')
    if (!header) return null
    const [actualSha = '', subject = '', date = '', author = ''] = header.split('\x1f')
    if (actualSha.toLowerCase() !== fullSha.toLowerCase()) return null
    let added = 0
    let removed = 0
    for (const line of stats) {
      const [a, r] = line.split('\t')
      if (a !== undefined && r !== undefined) {
        added += Number(a) || 0
        removed += Number(r) || 0
      }
    }
    return { sha: actualSha, subject, date, author, added, removed }
  }

  async function changedFiles(sha: string): Promise<string[]> {
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error('Invalid commit SHA')
    const result = await tryGit(
      root,
      ['diff-tree', '--no-commit-id', '--name-only', '-z', '-r', '--root', sha],
      opts,
    )
    if (!result.ok) {
      throw new GitError(
        `git diff-tree failed (${result.code}): ${result.stderr.split('\n')[0] ?? ''}`,
        result.code,
        result.stderr,
      )
    }
    return result.stdout.split('\0').filter((path) => path !== '')
  }

  async function commitFiles(limit: number): Promise<{ sha: string; files: string[] }[]> {
    // `-z` NUL-terminates every path and never quotes one, so a path with a
    // tab or a quote in it reads back as itself. RS leads each record, as in
    // `log`: after the sha comes NUL, a newline, then the NUL-terminated paths.
    const raw = await runGit(
      root,
      ['log', `-n${limit}`, '-z', '--name-only', '--format=%x1e%H'],
      opts,
    ).catch(() => '')
    return raw
      .split('\x1e')
      .filter((record) => record !== '')
      .map((record) => {
        const [sha = '', ...rest] = record.split('\0')
        const files = rest.map((p) => p.replace(/^\n/, '')).filter((p) => p !== '')
        return { sha: sha.trim(), files }
      })
  }

  async function head(): Promise<string | null> {
    const res = await tryGit(root, ['rev-parse', '--verify', 'HEAD'], opts)
    if (res.ok) {
      const sha = res.stdout.trim()
      if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
        const object = await tryGit(root, ['cat-file', '-e', `${sha}^{commit}`], opts)
        if (object.ok) return sha
      }
      throw new GitError(
        'Could not read repository HEAD.',
        1,
        'HEAD does not name an available commit.',
      )
    }

    // A missing HEAD is a pending baseline only for a valid symbolic branch
    // whose ref does not exist yet. All other rev-parse failures are errors.
    const symbolic = await tryGit(root, ['symbolic-ref', '--quiet', 'HEAD'], opts)
    const workTree = await tryGit(root, ['rev-parse', '--is-inside-work-tree'], opts)
    if (
      symbolic.ok &&
      workTree.ok &&
      workTree.stdout.trim() === 'true' &&
      /^refs\/heads\/[^\s]+$/.test(symbolic.stdout.trim())
    ) {
      const branch = symbolic.stdout.trim()
      const valid = await tryGit(root, ['check-ref-format', branch], opts)
      const ref = await tryGit(root, ['show-ref', '--verify', '--quiet', branch], opts)
      if (valid.ok && !ref.ok && ref.code === 1) return null
    }
    throw new GitError('Could not read repository HEAD.', res.code, res.stderr)
  }

  async function gitObjectType(id: string, readOpts: RunOpts): Promise<'commit' | 'tree' | null> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(id)) return null
    const result = await tryGit(root, ['cat-file', '-t', id], readOpts)
    if (!result.ok) return null
    const type = result.stdout.trim()
    return type === 'commit' || type === 'tree' ? type : null
  }

  /**
   * `from..to`, as paths with line counts.
   *
   * **Two calls, not one.** Passing `--numstat` and `--name-status` to one
   * `git diff` silently drops the counts (the last flag wins), so this joins two
   * results on the path.
   */
  async function rangeFiles(
    from: string,
    to: string,
    executionBudget?: { maxBuffer: number; timeout: number },
  ): Promise<RangeFile[]> {
    const readOpts = { ...opts, ...(executionBudget === undefined ? {} : { executionBudget }) }
    const fromType = await gitObjectType(from, readOpts)
    const toType = await gitObjectType(to, readOpts)
    if (fromType === null || toType === null) return []
    const range = `${from}..${to}`
    const stat = await tryGit(
      root,
      ['diff', '--numstat', '-z', '--no-color', '-M', range],
      readOpts,
    )
    const names = await tryGit(
      root,
      ['diff', '--name-status', '-z', '--no-color', '-M', range],
      readOpts,
    )
    if (!stat.ok || !names.ok) return []

    // `--numstat -z` is `added\tremoved\tpath\0`, and for a RENAME it spends
    // three NUL-separated fields: the counts line ends after the tab, then old
    // and new arrive as their own records.
    const counts = new Map<string, { added: number; removed: number }>()
    const statFields = stat.stdout.split('\0')
    for (let i = 0; i < statFields.length; i++) {
      const field = statFields[i]
      if (field === undefined || field === '') continue
      const first = field.indexOf('\t')
      const second = field.indexOf('\t', first + 1)
      if (first < 0 || second < 0) continue
      // A binary file reports `-` for both counts. Zero is the honest number to
      // show beside a picture; a dash in a `+N / -M` column reads as an error.
      const addedText = field.slice(0, first)
      const removedText = field.slice(first + 1, second)
      const added = addedText === '-' ? 0 : Number(addedText)
      const removed = removedText === '-' ? 0 : Number(removedText)
      // Two tabs and a trailing path: an ordinary entry. One trailing empty
      // field: a rename, whose two paths are the next two records.
      let path = field.slice(second + 1)
      if (path === '') {
        i += 2
        path = statFields[i] ?? ''
      }
      if (path !== '') counts.set(path, { added, removed })
    }

    // `--name-status -z` is `status\0path\0`, except a rename, which is
    // `R100\0old\0new\0`. Parsed as two fields the next file's status reads as
    // a path and everything after it is wrong.
    const out: RangeFile[] = []
    const nameFields = names.stdout.split('\0')
    for (let i = 0; i < nameFields.length; i++) {
      const status = nameFields[i]
      if (status === undefined || status === '') continue
      const renamed = status.startsWith('R') || status.startsWith('C')
      const oldPath = renamed ? (nameFields[i + 1] ?? '') : ''
      const path = nameFields[renamed ? i + 2 : i + 1] ?? ''
      i += renamed ? 2 : 1
      if (path === '') continue
      const shown = shownPathOrNull(path)
      if (shown === null || (renamed && shownPathOrNull(oldPath) === null)) continue
      const count = counts.get(path) ?? { added: 0, removed: 0 }
      out.push({ path: shown, status, added: count.added, removed: count.removed })
    }
    return out
  }

  /** A no-op when no merge is in progress, so the control can be pressed twice
   * without turning into an error. */
  async function abortMerge(): Promise<void> {
    if (await isMerging()) await runGit(root, ['merge', '--abort'], opts)
  }

  /**
   * The outbound half, and the only thing that leaves the machine. `--porcelain`
   * gives the per-ref result as `<flag>\t<from>:<to>\t<summary>`; see
   * `classifyPushFailure` for the stderr exception.
   */
  async function push(): Promise<PushResult> {
    const branch = await currentBranch()
    if (branch === null) return { kind: 'nothing-to-push' }
    // A repo created empty has no `origin/<branch>` ref yet, and neither has a
    // branch made here and never pushed. Counting against a missing ref
    // *errors*, which is not "nothing to push": count what no `origin` ref has.
    const hasRemote = (await remoteTarget()) !== null
    const range = hasRemote ? [`origin/${branch}..HEAD`] : ['HEAD', '--not', '--remotes=origin']
    const waiting = Number(
      await runGit(root, ['rev-list', '--count', ...range], opts).catch(() => '0'),
    )
    if (waiting === 0) return { kind: 'nothing-to-push' }

    // `-u` only on a branch's first push, so its ahead and behind have
    // something to count against. Every later push leaves `.git/config` alone.
    const upstream = await runGit(
      root,
      ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`],
      opts,
    ).catch(() => '')
    const res = await tryGit(
      root,
      [
        'push',
        '--porcelain',
        ...(upstream === '' ? ['-u'] : []),
        'origin',
        `HEAD:refs/heads/${branch}`,
      ],
      opts,
    )
    if (res.ok) return { kind: 'pushed', commits: waiting, branch }

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

  async function commitWithProvenance(args: string[]): Promise<string> {
    const recorder = deps.commitProvenance
    let ticket: unknown = null
    if (recorder !== undefined) {
      try {
        ticket = await recorder.begin(root)
      } catch (error) {
        console.error('[git] commit provenance capture failed:', error)
      }
    }
    let marker: string | null = null
    let before: string[] | null = null
    let beforeHead: string | null = null
    // Separate budgets either side of the commit: native hooks keep their normal
    // permissions and duration. Only provenance reads get a deadline/output cap.
    let deadline = Date.now() + 1000
    const evidenceOpts = (): RunOpts => {
      const timeout = deadline - Date.now()
      if (timeout <= 0) throw new GitResourceError('time')
      return {
        ...opts,
        env: { ...opts.env, GIT_NO_REPLACE_OBJECTS: '1' },
        executionBudget: { maxBuffer: 65536, timeout },
      }
    }
    // These are reads, not index mutations: never retry an evidence process.
    const probe = (command: string[]) =>
      runGitOnce(root, ['--no-replace-objects', ...command], evidenceOpts())
    const evidence = async (command: string[]) => {
      const outcome = await probe(command)
      if (!outcome.ok)
        throw new GitError('Commit evidence read failed', outcome.code, outcome.stderr)
      return outcome.stdout.trim()
    }
    if (recorder !== undefined && ticket !== null) {
      marker = `holi-managed-commit:${randomUUID()}`
      try {
        if (!(await probe(['rev-parse', '--verify', 'MERGE_HEAD'])).ok) {
          const head = await probe(['rev-parse', '--verify', 'HEAD'])
          beforeHead = head.ok ? head.stdout.trim() : null
          // One previous entry and its exact parent are enough to anchor a
          // single new entry. Never scan or materialize the historical reflog.
          before =
            beforeHead === null
              ? []
              : (await evidence(['reflog', 'show', '-n1', '--format=%H%x00%gs', 'HEAD']))
                  .split('\n')
                  .filter(Boolean)
          if (beforeHead !== null && before.length !== 1) throw new Error('Missing reflog anchor')
        }
      } catch (error) {
        before = null
        console.error('[git] commit reflog anchor unavailable:', error)
      }
    }
    await runGit(root, args, {
      ...opts,
      ...(marker === null ? {} : { env: { ...opts.env, GIT_REFLOG_ACTION: marker } }),
    })
    let exactOid: string | null = null
    if (marker !== null && before !== null) {
      deadline = Date.now() + 1000
      try {
        const after = (await evidence(['reflog', 'show', '-n2', '--format=%H%x00%gs', 'HEAD']))
          .split('\n')
          .filter(Boolean)
        if (after.length !== before.length + 1 || (before.length === 1 && after[1] !== before[0]))
          throw new Error('Missing or ambiguous commit reflog interval')
        const [oid, action] = after[0]!.split('\0')
        if (
          !oid ||
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid) ||
          !action?.startsWith(`${marker}:`)
        )
          throw new Error('Missing invocation marker')
        const type = await evidence(['cat-file', '-t', oid])
        const object = await evidence(['cat-file', '-p', oid])
        const headers = object.split('\n\n', 1)[0]!.split('\n')
        const parents = headers.filter((line) => line.startsWith('parent '))
        if (
          type !== 'commit' ||
          !/^tree (?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headers[0]!) ||
          parents.length > 1 ||
          (parents[0]?.slice('parent '.length) ?? null) !== beforeHead ||
          (await probe(['rev-parse', '--verify', 'MERGE_HEAD'])).ok
        )
          throw new Error('Commit object is not the managed non-merge invocation')
        exactOid = oid
      } catch (error) {
        console.error('[git] commit reflog evidence unavailable:', error)
      }
    }
    if (recorder !== undefined && ticket !== null) {
      try {
        // Null is an explicit evidence gap, including pre-commit read failure.
        await recorder.record(ticket, root, exactOid)
      } catch (error) {
        console.error('[git] commit provenance write failed:', error)
      }
    }
    // Preserve the historical API: return the current HEAD after hooks, even
    // when exact invocation evidence is unavailable. Only exactOid is recorded.
    return runGit(root, ['rev-parse', 'HEAD'], opts)
  }

  async function commitAll(message: string, paths: string[]): Promise<string | null> {
    // The caller decides what commits (the large-file gate holds oversized files
    // out by simply not naming them); an empty pathspec is the idle/all-held-back
    // path, nothing to do.
    if (paths.length === 0) return null
    // `-A -- <paths>` so deletions and untracked files among the named paths ride
    // along — a deleted note is a change to publish, a new one is the point — but
    // only those paths, never the whole tree.
    //
    // A path in neither the tree nor the index is a deletion already staged
    // (someone ran `git rm`). It is left out: naming it fails the whole add,
    // and the commit carries it anyway.
    const indexed = new Set(
      (await runGit(root, ['ls-files', '-z', '--', ...paths], opts)).split('\0'),
    )
    const present = await Promise.all(
      paths.map((p) =>
        lstat(join(root, p)).then(
          () => true,
          () => false,
        ),
      ),
    )
    const toAdd = paths.filter((p, i) => present[i] || indexed.has(p))
    if (toAdd.length > 0) await runGit(root, ['add', '-A', '--', ...toAdd], opts)
    // Nothing actually got staged (e.g. the named paths were already clean): not
    // an error, just the idle path — do not create an empty commit.
    if ((await tryGit(root, ['diff', '--cached', '--quiet'], opts)).ok) return null
    return commitWithProvenance([...(await identityArgs()), 'commit', '-m', message])
  }

  async function commitFileNoVerify(path: string): Promise<string | null> {
    // `--only` commits this working-tree path without consuming unrelated
    // staged entries. Literal pathspecs keep bracketed names exact.
    if (!(await status()).dirtyPaths.includes(path)) return null
    await runGit(root, ['--literal-pathspecs', 'add', '-A', '--', path], opts)
    return commitWithProvenance([
      '--literal-pathspecs',
      ...(await identityArgs()),
      'commit',
      '--only',
      '--no-verify',
      '-m',
      `Add ${path}`,
      '--',
      path,
    ])
  }

  /** Uses `.git/info/exclude`, not the shared `.gitignore`: another clone
   * decides for itself. An untracked file listed here stops being dirty, so it
   * leaves the held-back set on its own. */
  async function excludeLocally(path: string): Promise<void> {
    const tracked = await tryGit(
      root,
      ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path],
      opts,
    )
    if (tracked.ok) throw new Error('A tracked file cannot be kept local')
    const excludeFile = join(root, '.git', 'info', 'exclude')
    await mkdir(dirname(excludeFile), { recursive: true })
    // One file, not a pattern: anchored to the root so a same-named file in
    // another folder keeps syncing, and its glob characters escaped.
    const literal = path.replace(/[\\*?[\]]/g, '\\$&').replace(/ $/, '\\ ')
    await appendFile(excludeFile, `/${literal}\n`, 'utf8')
  }

  /**
   * `git status --porcelain=v2 --branch -z`, and nothing else. `-z` matters:
   * a path containing a newline would corrupt a line-based parse.
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
        // Any entry at all (changed, untracked or unmerged) means dirty.
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
      }
    }

    // An unborn or detached HEAD still has a branch name worth reporting, and
    // porcelain does not give one — ask the plumbing directly.
    if (branch === '') {
      branch = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'], opts).catch(() => '')
      if (branch === 'HEAD' || branch === '') {
        branch =
          (await runGit(root, ['symbolic-ref', '--short', 'HEAD'], opts).catch(() => '')) || branch
      }
    }

    // Holi always syncs with the namesake branch on origin, not Git's
    // configurable upstream. Porcelain's branch.ab therefore reports the
    // wrong counts when the upstream is absent or points elsewhere.
    if (!unborn && !detached && branch !== '') {
      const target = `refs/remotes/origin/${branch}`
      const exists = await tryGit(root, ['rev-parse', '--verify', '--quiet', target], opts)
      if (exists.ok) {
        const counts = await runGit(
          root,
          ['rev-list', '--left-right', '--count', `HEAD...${target}`],
          opts,
        ).catch(() => '0 0')
        const [local = '0', remote = '0'] = counts.split(/\s+/)
        ahead = Number(local)
        behind = Number(remote)
      } else {
        // A branch not yet on origin has no namesake commit to compare with.
        // Count commits no origin branch contains as pending pushes.
        ahead = Number(
          await runGit(
            root,
            ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'],
            opts,
          ).catch(() => '0'),
        )
        behind = 0
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

  /** The checked-out branch's name, or null on a detached HEAD. Works on an
   *  unborn branch too, which has a name but no commit. */
  async function currentBranch(): Promise<string | null> {
    const name = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], opts).catch(
      () => '',
    )
    return name === '' ? null : name
  }

  /**
   * What sync merges from: `origin/<checked-out branch>`, or null when there
   * is none (a detached HEAD, or a branch not pushed yet).
   *
   * **The namesake on `origin`, not `@{upstream}`.** Push writes to the same
   * name, so pull and push always agree on one remote branch, whatever a
   * hand-set upstream says. Holi sets the upstream to exactly this on a
   * branch's first push, so the two only differ when someone changed it.
   */
  async function remoteTarget(): Promise<string | null> {
    const branch = await currentBranch()
    if (branch === null) return null
    const ok = await tryGit(
      root,
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      opts,
    )
    return ok.ok ? `origin/${branch}` : null
  }

  async function branches(): Promise<BranchList> {
    // NUL between fields and a newline per ref: a ref name cannot hold either.
    const raw = await runGit(
      root,
      [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname)%00%(upstream)',
        'refs/heads',
        'refs/remotes/origin',
      ],
      opts,
    ).catch(() => '')
    const local: BranchList['local'] = []
    const remoteNames: string[] = []
    for (const line of raw.split('\n')) {
      const [ref = '', upstream = ''] = line.split('\0')
      if (ref.startsWith('refs/heads/')) {
        local.push({
          name: ref.slice('refs/heads/'.length),
          upstream: upstream === '' ? null : upstream.replace(/^refs\/remotes\//, ''),
        })
      } else if (ref.startsWith('refs/remotes/origin/')) {
        const name = ref.slice('refs/remotes/origin/'.length)
        // `origin/HEAD` is a pointer to the default branch, not a branch.
        if (name !== 'HEAD') remoteNames.push(name)
      }
    }
    const current = await currentBranch()
    // An unborn branch has no ref yet, but it is still the one checked out.
    if (current !== null && !local.some((b) => b.name === current)) {
      local.unshift({ name: current, upstream: null })
    }
    const localNames = new Set(local.map((b) => b.name))
    return {
      current,
      local,
      remote: remoteNames.filter((n) => !localNames.has(n)).map((name) => ({ name })),
    }
  }

  async function fetch(): Promise<void> {
    await runGit(root, ['fetch', 'origin'], opts)
  }

  async function switchBranch(name: string, o: { create?: boolean } = {}): Promise<void> {
    const valid = await validBranchName(root, name, opts)
    if (!valid) throw new BranchRefusedError(`“${name}” is not a valid branch name`)
    const s = await status()
    if (s.merging) throw new BranchRefusedError('A merge is in progress. Finish or abort it first.')
    if (s.dirty) {
      throw new BranchRefusedError(
        `${s.dirtyPaths.length} ${s.dirtyPaths.length === 1 ? 'file is' : 'files are'} not committed. Commit or keep them local first.`,
      )
    }
    const has = async (ref: string) =>
      (await tryGit(root, ['rev-parse', '--verify', '--quiet', ref], opts)).ok
    if (o.create) {
      if (await has(`refs/heads/${name}`)) {
        throw new BranchRefusedError(`A branch named “${name}” already exists`)
      }
      // `--no-track`: the new branch's upstream is set by its first push, to
      // its own namesake, never to the branch it was made from.
      await runGit(root, ['switch', '--no-track', '-c', name], opts)
      return
    }
    if (name === (await currentBranch())) return
    if (await has(`refs/heads/${name}`)) {
      await runGit(root, ['switch', name], opts)
    } else if (await has(`refs/remotes/origin/${name}`)) {
      await runGit(root, ['switch', '--track', `origin/${name}`], opts)
    } else {
      throw new BranchRefusedError(`There is no branch named “${name}”`)
    }
  }

  /** What `origin/HEAD` points at. Null when the remote never published one —
   * a local-only or freshly initialised repo. */
  async function defaultBranch(): Promise<string | null> {
    const ref = await runGit(
      root,
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      opts,
    ).catch(() => null)
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

  return {
    root,
    status,
    log,
    show,
    changedFiles,
    commit,
    commitFiles,
    head,
    rangeFiles,
    revisionChanges,
    commitAll,
    commitFileNoVerify,
    excludeLocally,
    pull,
    remerge,
    push,
    abortMerge,
    branches,
    fetch,
    switchBranch,
  }
}

/**
 * Is `name` a branch name git accepts as written? `check-ref-format --branch`
 * is git's own rule, run as an argument (never through a shell). It also
 * *expands* `@{-1}` into the previous branch, so only an answer equal to the
 * question counts; `@` is HEAD's alias and a leading dash reads as an option.
 */
export async function validBranchName(
  cwd: string,
  name: string,
  opts: RunOpts = {},
): Promise<boolean> {
  if (name === '' || name === '@' || name.startsWith('-') || name.length > 200) return false
  const res = await tryGit(cwd, ['check-ref-format', '--branch', name], opts)
  return res.ok && res.stdout.trim() === name
}

/**
 * `owner/repo` -> the HTTPS URL git clones from. Owned here so no caller
 * hand-builds one with a token embedded, which would persist into `.git/config`.
 * The credential arrives via GIT_ASKPASS instead.
 */
export function remoteUrl(remote: string): string {
  return `https://github.com/${remote}.git`
}

/**
 * Clone a vault. `url` rather than `owner/repo` so tests can point at a local
 * bare repo; production callers pass `remoteUrl(remote)`.
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
