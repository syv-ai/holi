/**
 * What automations seed into a vault (`vault/` beside this module): the
 * scheduled-agents skill, shipped, and the agent's rules for `holi schedules`.
 * A run starts an unattended session, so the person says yes to each one the
 * agent asks for; turning one on is no command at all (the editor's switch).
 */
import { seedFolder, type SeedContribution, type SettingsFragment } from '../../../main/plugin-api'

const folder = seedFolder(
  import.meta.glob(['./vault/**', '!**/.DS_Store'], {
    query: '?raw',
    import: 'default',
    eager: true,
    exhaustive: true,
  }),
)

const SETTINGS: SettingsFragment = {
  permissions: {
    ask: ['Bash(holi schedules run:*)'],
    allow: ['Bash(holi schedules list:*)'],
  },
}

export const automationsSeed: SeedContribution = {
  id: 'automations',
  once: folder.once,
  shipped: folder.shipped,
  fragments: { '.claude/settings.json': [SETTINGS] },
}
