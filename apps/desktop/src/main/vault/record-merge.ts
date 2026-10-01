/**
 * The merge driver for vault app records (docs/features/vaults-sync.md).
 *
 * A record is one JSON object in one file, so two people editing one record
 * would otherwise be a text conflict, and any conflict pauses the vault's sync
 * until someone reconciles. Git lets a repository name its own merge program per
 * path: this installs one for `*.app/data/**\/*.json` that merges field by field,
 * so edits of different fields both land and only a field both sides changed
 * differently is a conflict.
 *
 * **Machine-local, like the pre-commit hook.** The driver's definition is in
 * `.git/config` and its path pattern in `.git/info/attributes`, neither of which
 * is committed, so it is written on every open and reaches every existing vault
 * without touching its content. A clone without it (an older Holi, a terminal
 * elsewhere) just gets git's text merge.
 *
 * **A thin shim, like the pre-commit hook**: the script posts the three versions
 * to Holi, and the merge is `mergeRecordText` in `@holi/shared`, where it is
 * tested. Holi not answering is a failed merge, which git records as an
 * ordinary conflict: the safe way to fail.
 */
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runGit } from '../git'
import { shellReadBridgeEnv } from '../bridge/env-file'

/** The attribute line naming which paths the driver merges. The leading `**\/`
 *  matches a bundle at the root as well as a nested one. */
export const RECORD_ATTRIBUTES_LINE = '**/*.app/data/**/*.json merge=holi-record'

const SCRIPT = `#!/bin/sh
# Holi app-record merge driver (auto-generated on vault open).
# Git passes the base, ours and theirs versions of one record; Holi merges them
# field by field. Any failure exits 1, which git records as a normal conflict.
base="$1"; ours="$2"; theirs="$3"
# Holi is found the way every command in a vault finds it: the vault's
# .holi/state/bridge.local.env, read key by key, never sourced.
${shellReadBridgeEnv(['HOLI_BRIDGE_PORT', 'HOLI_BRIDGE_TOKEN']).join('\n')}
{ [ -n "$HOLI_BRIDGE_PORT" ] && [ -n "$HOLI_BRIDGE_TOKEN" ]; } || exit 1
out=$(mktemp) || exit 1
# --data-urlencode with @file keeps the file's bytes, newlines included.
code=$(curl -sS --max-time 10 -o "$out" -w '%{http_code}' -X POST \\
  "http://127.0.0.1:$HOLI_BRIDGE_PORT/merge/record?t=$HOLI_BRIDGE_TOKEN" \\
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

export async function installRecordMergeDriver(root: string): Promise<void> {
  const scriptPath = join(root, '.git', 'holi-merge-record')
  await writeFile(scriptPath, SCRIPT, 'utf8')
  await chmod(scriptPath, 0o755)

  // `git config` rather than editing the file: git owns its syntax. The path
  // is quoted because a vault's path may hold spaces.
  await runGit(root, ['config', '--local', 'merge.holi-record.name', 'Holi app record'])
  await runGit(root, [
    'config',
    '--local',
    'merge.holi-record.driver',
    `sh "${scriptPath}" %O %A %B`,
  ])

  // Line-wise: the attributes file may hold someone else's lines.
  const info = join(root, '.git', 'info')
  await mkdir(info, { recursive: true })
  const attributesPath = join(info, 'attributes')
  const existing = await readFile(attributesPath, 'utf8').catch(() => '')
  if (existing.split('\n').includes(RECORD_ATTRIBUTES_LINE)) return
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n'
  await appendFile(attributesPath, `${sep}${RECORD_ATTRIBUTES_LINE}\n`, 'utf8')
}
