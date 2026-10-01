/**
 * The large-file gate (docs/features/vaults-sync.md).
 *
 * Git history is permanent and replicated to every clone, and push is automatic
 * — so a big binary committed once is published to everyone before anyone
 * reacts, forever. This module keeps oversized files out: `partitionBySize` is
 * the pure decision the autosave loop uses to hold them back, and the pre-commit
 * hook (below) is the same gate for the agent's own direct commits.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { shellReadBridgeEnv } from '../bridge/env-file'

/** The default cap when `.holi/settings/app.yaml` sets no `maxCommittedFileBytes`.
 *  10 MB: notes-vault assets (images, PDFs) sit well under; this catches videos,
 *  datasets, exported binaries. (GitHub warns at 50 / blocks at 100 MB.) */
export const DEFAULT_MAX_COMMITTED_FILE_BYTES = VAULT_SETTING_DEFAULTS.maxCommittedFileBytes

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
 * `.holi/settings/app.yaml` change re-installs with the new number.
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
# Holi large-file guard (auto-generated; set maxCommittedFileBytes in .holi/settings/app.yaml).
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

# ---- the vault transforms -----------------------------------------
# Everything below this line is ADVISORY and exits 0 no matter what. The guard
# above vetoes because git history is permanent and push is automatic, so an
# oversized blob committed once is published forever. A transform is an opinion
# about formatting or link hygiene, and an opinion does not outrank a save.
#
# A thin shim on purpose: it hands the commit to Holi and the real work happens
# in TypeScript where it is tested. Holi not running is the normal case for a
# terminal commit and must cost nothing.
#
# Holi is found the way every command in a vault finds it: the vault's
# .holi/state/bridge.local.env, read key by key, never sourced. Git runs this
# at the top of the clone.
${shellReadBridgeEnv(['HOLI_BRIDGE_PORT', 'HOLI_BRIDGE_TOKEN']).join('\n')}
if [ -n "$HOLI_BRIDGE_PORT" ] && [ -n "$HOLI_BRIDGE_TOKEN" ]; then
  # --max-time is not optional: a commit that blocks for thirty seconds has
  # failed, as far as the person waiting on it is concerned.
  curl -sS --max-time 10 -X POST \\
    "http://127.0.0.1:$HOLI_BRIDGE_PORT/hooks/pre-commit?t=$HOLI_BRIDGE_TOKEN" >/dev/null 2>&1 || true
fi
exit 0
`
  const hookPath = join(hooksDir, 'pre-commit')
  await writeFile(hookPath, script, 'utf8')
  await chmod(hookPath, 0o755)
}
