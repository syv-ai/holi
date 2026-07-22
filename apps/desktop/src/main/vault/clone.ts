/**
 * Getting the clone for a vault — by cloning it, or by adopting what is already
 * at the path.
 *
 * **Nothing here deletes anything, ever.** `vaults.remove` deliberately leaves
 * the clone on disk (it may hold commits that never left the machine), so an
 * occupied clone path is a normal state rather than a corrupt one, and a
 * re-clone is precisely what would destroy that work. When the path cannot be
 * confidently claimed, this refuses and says what it found.
 *
 * `prd/vaults-sync.md` FR-1's "Holi never adopts a user-maintained checkout" is
 * about adopting a path the *user* chose. This adopts a path *Holi* chose, under
 * the managed root, which is a different thing.
 */
import { mkdir, readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { cloneRepo, openRepo, remoteUrl, runGit, type GitDeps, type GitRepo } from '../git'
import { clonePathFor, isRemote } from './registry'

export type CloneOutcome = { kind: 'cloned' } | { kind: 'adopted' }

/**
 * The clone path is taken by something this cannot claim. Carries what it found
 * so the message can name it — "that folder is a clone of someone/else" is
 * actionable, "that folder is in use" is not.
 */
export class ClonePathInUse extends Error {
  constructor(
    readonly path: string,
    readonly foundRemote: string | null,
  ) {
    super(
      foundRemote === null
        ? `${path} already exists and is not a Holi clone.`
        : `${path} is a clone of ${foundRemote}.`,
    )
    this.name = 'ClonePathInUse'
  }
}

/**
 * `owner/repo` out of a GitHub remote URL, or **null** when the URL is not
 * GitHub-shaped.
 *
 * Null is a real answer, not a failure: a clone made from a local path has a
 * `file:///` or bare-path origin that cannot be compared to an `owner/repo` at
 * all, and treating "cannot compare" as "does not match" would refuse a clone
 * that is legitimately ours.
 */
export function githubRemoteOf(url: string): string | null {
  const match =
    /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url) ??
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
  return match ? `${match[1]}/${match[2]}` : null
}

async function isEmptyOrAbsent(path: string): Promise<boolean> {
  // ENOENT is the ordinary case; an empty directory is treated the same, because
  // `git clone` accepts one and a leftover empty folder is not someone's work.
  const entries = await readdir(path).catch(() => null)
  return entries === null || entries.length === 0
}

export async function ensureClone(args: {
  root: string
  remote: string
  /** Where to clone *from*. Defaults to the remote's GitHub URL; tests point it
   *  at a local bare repo, which is also how the sync loop is exercised without
   *  a token. Unused when the path is adopted. */
  url?: string
  deps?: GitDeps
}): Promise<{ repo: GitRepo; outcome: CloneOutcome }> {
  // Validate before touching the filesystem: the remote becomes a path under the
  // managed root, so a traversal must fail here rather than one call later.
  if (!isRemote(args.remote)) throw new Error(`not an owner/repo remote: ${args.remote}`)
  const dest = clonePathFor(args.root, args.remote)

  if (await isEmptyOrAbsent(dest)) {
    await mkdir(dirname(dest), { recursive: true })
    const repo = await cloneRepo({ url: args.url ?? remoteUrl(args.remote), dest }, args.deps)
    return { repo, outcome: { kind: 'cloned' } }
  }

  // Occupied. The only question is whether it is ours.
  const origin = await runGit(dest, ['remote', 'get-url', 'origin'], args.deps).catch(() => null)
  if (origin === null || origin === '') throw new ClonePathInUse(dest, null)

  const found = githubRemoteOf(origin)
  // `found === null` means a non-GitHub origin, which cannot be compared — and
  // the directory is a git repo at the exact path Holi computes under its own
  // managed root, so it is Holi's clone by construction.
  if (found !== null && found.toLowerCase() !== args.remote.toLowerCase()) {
    throw new ClonePathInUse(dest, found)
  }

  return { repo: openRepo(dest, args.deps), outcome: { kind: 'adopted' } }
}
