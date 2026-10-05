/**
 * What Notes seeds into a vault (`vault/` beside this module): the `Notes.app`
 * bundle, once, so a vault that edits it keeps its edits. The records in
 * `Notes.app/data/` are the vault's and are never seeded.
 */
import { seedFolder, type SeedContribution } from '../../../main/plugin-api'

const folder = seedFolder(
  import.meta.glob(['./vault/**', '!**/.DS_Store'], {
    query: '?raw',
    import: 'default',
    eager: true,
    exhaustive: true,
  }),
)

export const notesSeed: SeedContribution = {
  id: 'notes',
  once: folder.once,
  shipped: folder.shipped,
}
