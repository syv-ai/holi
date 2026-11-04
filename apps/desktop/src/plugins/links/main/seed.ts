/**
 * What links seeds into a vault (`vault/` beside this module): the
 * using-links skill, shipped, in the agent's `.claude/`.
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

export const linksSeed: SeedContribution = {
  id: 'links',
  once: folder.once,
  shipped: folder.shipped,
}
