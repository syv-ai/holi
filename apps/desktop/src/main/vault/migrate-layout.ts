/**
 * `.holi/` layout: `settings/` for what a person chooses, `state/` for machine
 * state, and the `.holi/vault` flag at the top.
 *
 * `icons` stays its own file rather than merging into `theme`: a theme is a
 * closed token whitelist validated as CSS (D64's security property is that the
 * vocabulary is closed), an icon map is unbounded and user-generated.
 *
 * **The filenames keep their `.local.` marker** even under `state/`. D65 makes
 * that marker the whole of what "machine-local" means and the seeded
 * `.gitignore` carries exactly `*.local.*`, so a bare name there gets committed.
 *
 * This is a move and not a deletion because of `seed-state.local.json`: it holds
 * what Holi seeded, the base `holi skills update` merges against (D111), and
 * without it every file the vault changed would need an agent to merge.
 */
import { access, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Machine state. Hidden from the tree by its dot-prefixed ancestor (`isHiddenPath`). */
export const STATE_DIR = '.holi/state'

/** Everything a person chooses. */
export const SETTINGS_DIR = '.holi/settings'

/** `<old path>` → `<new path>`, both vault-relative. Deliberately literals
 *  rather than today's constants: a migration table written in terms of the
 *  current constants describes a move from a place to itself. */
const MOVES: readonly (readonly [string, string])[] = [
  // Machine state.
  ['.holi/seed-state.local.json', '.holi/state/seed-state.local.json'],
  ['.holi/context.local.json', '.holi/state/context.local.json'],
  ['.holi/hooks.local.log', '.holi/state/hooks.local.log'],
  ['.holi/hook-endpoint.local.txt', '.holi/state/hook-endpoint.local.txt'],
  ['.holi/turns.local.json', '.holi/state/turns.local.json'],
  // Settings, theme and icons. These are COMMITTED (bar the `.local.` ones), so
  // this half of the move is a change collaborators see.
  //
  // **Still `.json` on the right, deliberately.** `migrateSettingsFormat` runs
  // straight after this and converts them to YAML, so neither step needs to
  // know about the other.
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
      // **Checked before the mkdir**, or every vault without these files would
      // get an empty `.holi/state/`.
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
