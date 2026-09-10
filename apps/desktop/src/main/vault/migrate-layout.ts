/**
 * `.holi/` gets a shape: `settings/`, `state/`, and one flag (#16).
 *
 * `.holi/` had grown eleven files, and they were not one kind of thing. Four
 * are **settings** somebody reads and edits (`settings.json`, `theme.json` and
 * their `.local.` overrides), one is the **marker** that says this clone is a
 * vault at all, two are **data** the app writes on your behalf but you can
 * meaningfully open (`icons.json`), and the rest is machine state nobody has
 * any reason to look at: what the seed last wrote, which note is focused, where
 * the hook server is listening, and a log.
 *
 * So there are two directories and one loose file:
 *
 * - **`settings/`** — `app.json`, `theme.json`, `icons.json` and their `.local.`
 *   overrides. Everything a person chooses about this vault. `app.json` rather
 *   than `settings.json`, because `settings/settings.json` was the one path in
 *   this layout that read badly.
 * - **`state/`** — the machine-local four. Nobody opens these.
 * - **`.holi/vault`** — the flag, at the top, because a marker buried a level
 *   down is a worse marker. Not JSON any more: nothing ever parsed it.
 *
 * `icons.json` joins the settings rather than merging INTO `theme.json`, which
 * was considered. They share only a layering pattern: a theme is a closed
 * whitelist of ~31 tokens in `light`/`dark` blocks, validated as CSS, and D64's
 * security property IS that the vocabulary is closed. An icon map is one entry
 * per path — unbounded, user-generated, validated as a single emoji, and it
 * rots on rename by design. Two schemas and two validators in one file buys a
 * shorter `ls`.
 *
 * **The filenames keep their `.local.` marker**, which is not redundant with
 * living under `state/`. D65 makes that marker the whole of what "machine-local"
 * means and the seeded `.gitignore` carries exactly `*.local.*` — rename them to
 * bare names under a directory that merely sounds private and git starts
 * committing them. The one place that rule was broken (a duplicate named
 * `x.local copy.md`) published a personal file, so it is not a hypothetical.
 *
 * **Every one of these is regenerable, and one of them still matters.** A lost
 * `context.local.json` costs one turn of focused-note context; a lost endpoint
 * file and log cost nothing. `seed-state.local.json` is the exception: it holds
 * the hashes proving Holi wrote a managed file, and "no record means no
 * refresh", so losing it would quietly stop that vault ever receiving an
 * improved skill again. That file alone is why this is a move and not a
 * deletion.
 */
import { access, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Where machine state lives now. Hidden from the tree already — every segment
 *  under a dot-prefixed ancestor is (`isHiddenPath`). */
export const STATE_DIR = '.holi/state'

/** Where everything a person chooses lives now. */
export const SETTINGS_DIR = '.holi/settings'

/** `<old path>` → `<new path>`, both vault-relative. The new paths are the
 *  constants their own modules export; this list is deliberately a literal
 *  rather than derived from them, so a future move of one file cannot silently
 *  re-migrate the last one. */
const MOVES: readonly (readonly [string, string])[] = [
  // Machine state.
  ['.holi/seed-state.local.json', '.holi/state/seed-state.local.json'],
  ['.holi/context.local.json', '.holi/state/context.local.json'],
  ['.holi/hooks.local.log', '.holi/state/hooks.local.log'],
  ['.holi/hook-endpoint.local.txt', '.holi/state/hook-endpoint.local.txt'],
  ['.holi/turns.local.json', '.holi/state/turns.local.json'],
  // Settings, theme and icons. These are COMMITTED (bar the `.local.` ones), so
  // unlike the four above this half of the move is a change collaborators see.
  //
  // **The left column is deliberately a dead literal.** These paths no longer
  // exist anywhere else in the codebase, which is the point: a migration table
  // written in terms of today's constants describes a move from a place to
  // itself. A project-wide rename of the old paths did exactly that to this
  // list once already.
  ['.holi/settings.json', '.holi/settings/app.json'],
  ['.holi/settings.local.json', '.holi/settings/app.local.json'],
  ['.holi/theme.json', '.holi/settings/theme.json'],
  ['.holi/theme.local.json', '.holi/settings/theme.local.json'],
  ['.holi/icons.json', '.holi/settings/icons.json'],
  ['.holi/icons.local.json', '.holi/settings/icons.local.json'],
  // The flag, which stops being a document.
  ['.holi/vault.json', '.holi/vault'],
]

/**
 * Move any machine state still at its old path. Returns what it moved.
 *
 * **Never throws.** This runs on the way into a vault, ahead of the watcher and
 * the sync loop, and none of these files is worth refusing to open a vault
 * over. A file that is absent, already moved, or locked is skipped: the worst
 * case is a regenerable file written fresh at the new path, and a stale one
 * left behind where nothing reads it.
 */
export async function migrateVaultLayout(root: string): Promise<string[]> {
  const moved: string[] = []
  for (const [from, to] of MOVES) {
    const source = join(root, from)
    const target = join(root, to)
    try {
      // **Checked before the mkdir, not after.** Creating the directory first
      // and letting `rename` fail would leave an empty `.holi/state/` in every
      // vault that never had any of these — litter, in the directory this
      // change exists to tidy.
      await access(source)
      await mkdir(dirname(target), { recursive: true })
      await rename(source, target)
      moved.push(to)
    } catch {
      // Absent, already moved, or unreadable. All three mean: carry on.
    }
  }
  return moved
}
