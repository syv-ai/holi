/**
 * What Transcribe seeds into a vault (`vault/` beside this module): the
 * `Transcribe.local.app` bundle, once. The `.local.` in the name keeps the app
 * and its records on this machine (gitignored), which is where the API key it
 * stores belongs, and where recorded meetings stay. No records are seeded.
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

export const transcribeSeed: SeedContribution = {
  id: 'transcribe',
  once: folder.once,
  shipped: folder.shipped,
}
