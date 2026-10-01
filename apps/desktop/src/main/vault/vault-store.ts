/**
 * The vault store: the filesystem, read as a vault. A "scan" is a directory
 * walk and a parse; the watcher only says *when* to do it again.
 *
 * Two rules the tests pin, both of which cost data if broken:
 *
 *   - A claimed file (a task) is claimed because of its **path**, by the
 *     plugin's `match`, and a daily note is a daily because of its
 *     **frontmatter** (`type: daily-note`). Never the other way round: a
 *     filename that merely looks like a date is often a note a human wrote,
 *     and the archive sweep deletes empty dailies.
 *   - A claimed file that does not parse is **reported, not dropped**.
 *     Silently omitting it from its view is indistinguishable from data loss,
 *     and the model will occasionally write bad frontmatter.
 *
 * Which files are claimed depends on the plugins the vault runs, so every
 * caller passes the claims (`PluginHost.scanClaimsFor`). With a plugin off its
 * files are plain notes.
 */
import { readFile, stat } from 'node:fs/promises'
import {
  isKeepFile,
  isLocalOnlyPath,
  ICONS_FILE,
  ICONS_LOCAL_FILE,
  resolveIconMap,
  type SnapshotClaim,
  type VaultSnapshot,
} from '@holi/shared'
import { ignoredPaths } from './git-ignored'
import { isNonContentPath, listFiles } from './vault-files'

// The shape is `@holi/shared`'s: the renderer reads it too, and a type that
// crossed the IPC seam by being imported out of `main/` would make the seam a
// lie. Re-exported so the scan and its result still read as one module.
export type { VaultSnapshot } from '@holi/shared'

/** A claim, and the plugin whose `snapshot.claimed` entry it fills. */
export interface ScanClaim extends SnapshotClaim {
  plugin: string
}

/**
 * `type: daily-note` in the file's **leading** frontmatter block, and nowhere
 * else. Scanning the whole text would let a note containing a horizontal rule
 * and the words `type: daily-note` be classified as a system-created daily —
 * and the archive sweep deletes empty dailies, so a false positive here is how
 * you lose someone's note.
 */
function isDaily(text: string): boolean {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return false
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return false
  return /^type:[ \t]*daily-note[ \t]*$/m.test(normalized.slice(4, end + 1))
}

/** Everything the vault holds, read fresh off disk. */
export async function scanVault(
  root: string,
  claims: readonly ScanClaim[],
): Promise<VaultSnapshot> {
  const snapshot: VaultSnapshot = {
    docs: [],
    claimed: Object.fromEntries(claims.map((c) => [c.plugin, { items: [], broken: [] }])),
    files: [],
    dirs: [],
    icons: {},
    ignored: [],
  }

  // `.holi/settings/icons.yaml` (committed) under `.holi/settings/icons.local.yaml` (personal),
  // the theme's layering. Read here rather than over its own IPC so the tree
  // gets the map in the same push as the paths it decorates — a second channel
  // would mean a render where a folder's icon had not arrived yet.
  const iconJson = await Promise.all(
    [ICONS_FILE, ICONS_LOCAL_FILE].map((rel) =>
      readFile(`${root}/${rel}`, 'utf8').catch(() => null),
    ),
  )
  snapshot.icons = resolveIconMap(iconJson[0] ?? null, iconJson[1] ?? null).icons

  // Exclude only true non-content (dirs/tmp/junk). Local-only files (`*.local.*`)
  // DO reach the snapshot so the tree can show them under show-hidden; git keeps
  // them out of a commit, not this filter.
  const all = (await listFiles(root)).filter((rel) => !isNonContentPath(rel))

  // Every ancestor directory of every file on disk. The tree shows a folder from
  // this set even when its own contents are all filtered out downstream (a
  // folder of only claimed files, or only hidden files) or it is empty but for a
  // `.gitkeep`. Derived from the raw walk, before the doc/task/file bucketing a
  // filtered tree would otherwise hide the folder behind.
  const dirs = new Set<string>()
  for (const rel of all) {
    const parts = rel.split('/')
    parts.pop() // drop the filename; keep the directory chain
    let acc = ''
    for (const seg of parts) {
      acc = acc ? `${acc}/${seg}` : seg
      dirs.add(acc)
    }
  }
  snapshot.dirs = [...dirs]

  // Asked of the walk's own list plus the directories derived from it, so the
  // cost is bounded by the tree we are about to render rather than by what is
  // on disk — a vault app's `node_modules` is already out of `all`, and
  // `git status --ignored` would have enumerated every file inside it.
  //
  // Directories are included because a wholly-ignored FOLDER looking like
  // ordinary content is the same complaint one level up from a file doing it.
  snapshot.ignored = await ignoredPaths(root, [...all, ...snapshot.dirs])

  for (const path of all) {
    // A keep-marker exists only to hold its directory open (already captured in
    // `dirs`); it is never content, so it joins no list and shows as no leaf.
    if (isKeepFile(path)) continue

    const mtime = () =>
      stat(`${root}/${path}`)
        .then((s) => s.mtime.toISOString())
        .catch(() => new Date(0).toISOString())

    // Non-markdown OR local-only: a plain file entry. No read, no parse — it is
    // not a note, so it stays out of `docs` and the link-aware ops
    // (backrefs/rename/mentions) never see it. Local-only markdown (USER.local.md,
    // CLAUDE.local.md) is content the tree shows but the note graph must not
    // absorb: it is personal config, not a linkable note.
    if (!path.endsWith('.md') || isLocalOnlyPath(path)) {
      snapshot.files.push({ path, updatedAt: await mtime() })
      continue
    }

    const text = await readFile(`${root}/${path}`, 'utf8').catch(() => null)
    // A file that vanished between the walk and the read is not an error: the
    // watcher is about to tell us about it anyway.
    if (text === null) continue

    const claim = claims.find((c) => c.match(path))
    if (claim !== undefined) {
      const into = snapshot.claimed[claim.plugin]!
      try {
        into.items.push(claim.parse(text, path))
      } catch (err) {
        into.broken.push({ path, error: err instanceof Error ? err.message : String(err) })
      }
      continue
    }

    snapshot.docs.push({ path, kind: isDaily(text) ? 'daily' : 'note', updatedAt: await mtime() })
  }

  return snapshot
}
