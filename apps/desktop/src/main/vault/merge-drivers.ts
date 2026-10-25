/**
 * The merge drivers for Holi's JSON files (docs/features/vaults-sync.md).
 *
 * A vault app's record is one JSON object in one file, and so is a note's
 * comment threads, so two people editing one would otherwise be a text conflict, and any conflict pauses the
 * vault's sync until someone reconciles. Git lets a repository name its own
 * merge program per path: each driver here claims a path pattern and merges
 * what it understands, so edits that do not collide both land and only a real
 * collision is a conflict.
 *
 * **Machine-local, like the pre-commit hook.** A driver's definition is in
 * `.git/config` and its path pattern in `.git/info/attributes`, neither of
 * which is committed, so it is written on every open and reaches every
 * existing vault without touching its content. A clone without it (an older
 * Holi, a terminal elsewhere) just gets git's text merge.
 *
 * **A thin shim, like the pre-commit hook**: one script posts the three
 * versions to the driver's route on Holi's bridge (`git-routes.ts`), and the
 * merge itself is in `@holi/shared`, where it is tested. Holi not answering is
 * a failed merge, which git records as an ordinary conflict: the safe way to
 * fail.
 */
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runGit } from '../git'
import { shellReadBridgeEnv } from '../bridge/env-file'

export interface MergeDriver {
  /** Git's name for it, `merge=<name>` in the attributes. */
  name: string
  /** What `git config` says it is. */
  label: string
  /** The paths it merges, in gitattributes syntax. */
  pattern: string
  /** The bridge route that merges one file's three versions. */
  route: string
}

export const MERGE_DRIVERS: readonly MergeDriver[] = [
  {
    name: 'holi-record',
    label: 'Holi app record',
    // The leading `**/` matches a bundle at the root as well as a nested one.
    pattern: '**/*.app/data/**/*.json',
    route: '/merge/record',
  },
  {
    // A note's comment threads, unioned by id (docs/features/note-comments.md).
    name: 'holi-comments',
    label: 'Holi note comments',
    pattern: '.holi/comments/**/*.json',
    route: '/merge/comments',
  },
]

/** The attribute line naming the paths `driver` merges. */
export const attributesLine = (driver: MergeDriver): string =>
  `${driver.pattern} merge=${driver.name}`

/** One script for every driver: the route is its fourth argument. */
const SCRIPT = `#!/bin/sh
# Holi's merge driver (auto-generated on vault open).
# Git passes the base, ours and theirs versions of one file; Holi merges them
# at the route named last. Any failure exits 1, which git records as a normal
# conflict.
base="$1"; ours="$2"; theirs="$3"; route="$4"
# Holi is found the way every command in a vault finds it: the vault's
# .holi/state/bridge.local.env, read key by key, never sourced.
${shellReadBridgeEnv(['HOLI_BRIDGE_PORT', 'HOLI_BRIDGE_TOKEN']).join('\n')}
{ [ -n "$HOLI_BRIDGE_PORT" ] && [ -n "$HOLI_BRIDGE_TOKEN" ]; } || exit 1
out=$(mktemp) || exit 1
# --data-urlencode with @file keeps the file's bytes, newlines included.
code=$(curl -sS --max-time 10 -o "$out" -w '%{http_code}' -X POST \\
  "http://127.0.0.1:$HOLI_BRIDGE_PORT$route?t=$HOLI_BRIDGE_TOKEN" \\
  --data-urlencode "base@$base" --data-urlencode "ours@$ours" \\
  --data-urlencode "theirs@$theirs") || { rm -f "$out"; exit 1; }
if [ "$code" = 200 ]; then
  cat "$out" > "$ours"
  rm -f "$out"
  exit 0
fi
rm -f "$out"
exit 1
`

export async function installMergeDrivers(root: string): Promise<void> {
  const scriptPath = join(root, '.git', 'holi-merge')
  await writeFile(scriptPath, SCRIPT, 'utf8')
  await chmod(scriptPath, 0o755)

  // `git config` rather than editing the file: git owns its syntax. The path
  // is quoted because a vault's path may hold spaces.
  for (const driver of MERGE_DRIVERS) {
    await runGit(root, ['config', '--local', `merge.${driver.name}.name`, driver.label])
    await runGit(root, [
      'config',
      '--local',
      `merge.${driver.name}.driver`,
      `sh "${scriptPath}" %O %A %B ${driver.route}`,
    ])
  }

  // Line-wise: the attributes file may hold someone else's lines.
  const info = join(root, '.git', 'info')
  await mkdir(info, { recursive: true })
  const attributesPath = join(info, 'attributes')
  const existing = await readFile(attributesPath, 'utf8').catch(() => '')
  const have = new Set(existing.split('\n'))
  const missing = MERGE_DRIVERS.map(attributesLine).filter((line) => !have.has(line))
  if (missing.length === 0) return
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
  await appendFile(attributesPath, `${sep}${missing.join('\n')}\n`, 'utf8')
}
