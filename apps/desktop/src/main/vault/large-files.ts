/**
 * The large-file gate (docs/specs/2026-08-03-large-binary-policy-design.md).
 *
 * Git history is permanent and replicated to every clone, and push is automatic
 * (D61) — so a big binary committed once is published to everyone before anyone
 * reacts, forever. This module keeps oversized files out: `partitionBySize` is
 * the pure decision the autosave loop uses to hold them back, and the pre-commit
 * hook (below) is the same gate for the agent's own direct commits.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The default cap when `.holi/settings.json` sets no `maxCommittedFileBytes`.
 *  10 MB: notes-vault assets (images, PDFs) sit well under; this catches videos,
 *  datasets, exported binaries. (GitHub warns at 50 / blocks at 100 MB.) */
export const DEFAULT_MAX_COMMITTED_FILE_BYTES = 10 * 1024 * 1024

export interface HeldBackFile {
  path: string
  bytes: number
}

/**
 * Split dirty paths into what to commit vs what to hold back. `sizeOf` returns
 * the working-tree byte size, or `null` for a path with no file — a deletion,
 * which always commits (it shrinks history). Only a file strictly over the
 * threshold is held back. Pure: the async stat happens in the caller.
 */
export function partitionBySize(
  dirtyPaths: string[],
  sizeOf: (path: string) => number | null,
  threshold: number,
): { commit: string[]; heldBack: HeldBackFile[] } {
  const commit: string[] = []
  const heldBack: HeldBackFile[] = []
  for (const path of dirtyPaths) {
    const bytes = sizeOf(path)
    if (bytes !== null && bytes > threshold) {
      heldBack.push({ path, bytes })
    } else {
      commit.push(path)
    }
  }
  return { commit, heldBack }
}

/**
 * Install (or regenerate) the machine-local pre-commit hook that is the same
 * gate for the agent's own commits (and any direct `git`). Holi's selective-add
 * never stages an oversized file so never trips this; the agent commits in the
 * same clone, so it does. Git hooks live in `.git/hooks/` and are not committed,
 * so this is written per clone on open — the resolved limit is baked in, so a
 * `.holi/settings.json` change re-installs with the new number.
 *
 * Bounded, not a prison: `git commit --no-verify` bypasses it, matching the
 * agent-security stance (guard accidents, don't blocklist git). POSIX `sh`; the
 * line-based read is a backstop (a filename with a newline is not handled), fine
 * because Holi's own commit path uses NUL and this only catches direct-git slips.
 */
export async function installGitHook(root: string, threshold: number): Promise<void> {
  const hooksDir = join(root, '.git', 'hooks')
  await mkdir(hooksDir, { recursive: true })
  const script = `#!/bin/sh
# Holi large-file guard (auto-generated; set maxCommittedFileBytes in .holi/settings.json).
limit=${threshold}
offenders=$(git diff --cached --name-only --diff-filter=AM | while IFS= read -r f; do
  [ -f "$f" ] || continue
  size=$(wc -c < "$f" | tr -d ' ')
  [ "$size" -gt "$limit" ] && printf '  %s (%s bytes)\\n' "$f" "$size"
done)
if [ -n "$offenders" ]; then
  echo "Holi: refusing to commit files over $limit bytes:" >&2
  echo "$offenders" >&2
  echo "Keep them local, set up Git LFS, or 'git commit --no-verify' to override." >&2
  exit 1
fi
`
  const hookPath = join(hooksDir, 'pre-commit')
  await writeFile(hookPath, script, 'utf8')
  await chmod(hookPath, 0o755)
}
