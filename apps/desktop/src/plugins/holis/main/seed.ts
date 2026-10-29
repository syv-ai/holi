/**
 * What Holis seed into a vault (`vault/` beside this module): the holis skill,
 * shipped, which teaches the agent a Holi's folder, its soul and memory, and
 * what a run says when it is done.
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

export const holisSeed: SeedContribution = {
  id: 'holis',
  once: folder.once,
  shipped: folder.shipped,
}
