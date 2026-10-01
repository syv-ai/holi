/**
 * What vault apps seed into a vault (`vault/` beside this module): the
 * vault-apps skill and the vault-app-check hook, shipped, and the agent's
 * settings for them.
 *
 * The check is advisory (it reports and exits 0), so the agent gets feedback
 * instead of a syntax error surfacing as a blank tab. It is matched on the
 * writing tools rather than on the path, because the matcher grammar cannot
 * see a path; the hook returns at once outside a `<name>.app/`.
 *
 * `holi apps` and `holi store` run without asking: opening an app is
 * reversible, and a record write is a vault file like any the agent writes,
 * checked against its schema.
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
  hooks: [{ event: 'PostToolUse', matcher: 'Write|Edit|MultiEdit', script: 'vault-app-check' }],
  permissions: { allow: ['Bash(holi apps:*)', 'Bash(holi store:*)'] },
}

export const appsSeed: SeedContribution = {
  id: 'apps',
  once: folder.once,
  shipped: folder.shipped,
  fragments: { '.claude/settings.json': [SETTINGS] },
}
