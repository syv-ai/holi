/**
 * What tasks seeds into a vault (`vault/` beside this module): the
 * using-tasks skill, shipped, and the deny rules for Claude Code's own todo
 * tools, whose "tasks" are not the vault's `task.*.md` (TaskStop stays: it
 * stops background shells). Both live in the agent's `.claude/`, so they wait
 * until the agent runs.
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

export const tasksSeed: SeedContribution = {
  id: 'tasks',
  once: folder.once,
  shipped: folder.shipped,
  fragments: {
    '.claude/settings.json': [
      { permissions: { deny: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'] } },
    ],
  },
}
