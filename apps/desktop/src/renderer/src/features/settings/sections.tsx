/**
 * The settings tab's sections, in rail order: core's, with every enabled
 * plugin's after the vault's own content and before Vault and Account.
 *
 * The rail, the section view and the narrow-pane picker all read
 * `settingsSectionsAtom`, so adding a section is adding an entry here, or a
 * plugin's `settingsSections`, and nothing else.
 *
 * `headings` is what the rail shows beneath the section you are in. They are
 * **declared** rather than scraped from the DOM, which could only happen after
 * render. Declaring them means the rail and content can drift, so a test
 * asserts every declared heading renders. A section with no headings does not
 * expand.
 */
import {
  ICONS_FILE,
  PLUGINS_FILE,
  PLUGINS_LOCAL_FILE,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  THEME_FILE,
  THEME_LOCAL_FILE,
  THEME_TOKEN_GROUPS,
} from '@holi/shared'
import { atom } from 'jotai'
import type { SettingsSection, SettingsSectionHeading } from '@/plugin-api/types'
import { pluginSettingsSectionsAtom, runningPluginsAtom } from '@/state/plugins'
import { PluginSettingsSection } from './PluginSettingsSection'
import { AccountSection } from './AccountSection'
import { DescriptorSection } from './DescriptorSection'
import { IconsSection } from './IconsSection'
import { ThemeSection } from './ThemeSection'
import { UpdatesSection } from './UpdatesSection'
import { VaultSection } from './VaultSection'
import { headingId } from '@/composites'
import { LIGHT_AND_DARK } from './appearance-headings'
import { COLLABORATORS, LEAVE_OR_DELETE, WHERE_IT_LIVES } from './vault-headings'

export type { SettingsSection, SettingsSectionHeading }

const heading = (title: string): SettingsSectionHeading => ({ id: headingId(title), title })

/** What the vault holds: its settings, its look, its commits. */
const VAULT_CONTENT: readonly SettingsSection[] = [
  {
    id: 'general',
    label: 'General',
    headings: [],
    // The plugins row is here, and it writes the plugins files.
    files: [SETTINGS_FILE, SETTINGS_LOCAL_FILE, PLUGINS_FILE, PLUGINS_LOCAL_FILE],
    Component: () => <DescriptorSection section="general" />,
  },
  {
    id: 'editor',
    label: 'Editor',
    headings: [],
    files: [SETTINGS_FILE, SETTINGS_LOCAL_FILE],
    Component: () => <DescriptorSection section="editor" />,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    // The one long section, and the reason the rail has a second level at all.
    // Derived from `THEME_TOKEN_GROUPS`, so a new group is a new rail child.
    headings: [heading(LIGHT_AND_DARK), ...THEME_TOKEN_GROUPS.map((g) => heading(g.title))],
    files: [THEME_FILE, THEME_LOCAL_FILE],
    Component: ({ remote }) => <ThemeSection remote={remote} />,
  },
  {
    id: 'icons',
    label: 'Icons',
    headings: [],
    files: [ICONS_FILE],
    Component: () => <IconsSection />,
  },
  {
    id: 'commits',
    label: 'Commits',
    headings: [],
    files: [SETTINGS_FILE, SETTINGS_LOCAL_FILE],
    Component: () => <DescriptorSection section="commits" />,
  },
]

/** The vault itself, who you are, and the app you run: always last. */
const VAULT_AND_ACCOUNT: readonly SettingsSection[] = [
  {
    id: 'vault',
    label: 'Vault',
    headings: [heading(WHERE_IT_LIVES), heading(COLLABORATORS), heading(LEAVE_OR_DELETE)],
    // What GitHub says, not what a file says. `.holi/vault` is the marker that
    // this clone IS a vault and holds nothing to edit.
    files: [],
    Component: () => <VaultSection />,
  },
  {
    id: 'account',
    label: 'Account',
    headings: [],
    files: [],
    Component: () => <AccountSection />,
  },
  {
    id: 'updates',
    label: 'Updates',
    headings: [],
    files: [],
    Component: () => <UpdatesSection />,
  },
]

/** Core's sections alone. */
export const CORE_SETTINGS_SECTIONS: readonly SettingsSection[] = [
  ...VAULT_CONTENT,
  ...VAULT_AND_ACCOUNT,
]

/** A section of a running plugin's own settings, for each one that declares
 *  any (`PluginInfo.settings`), named after the plugin. */
const pluginOwnSettingsAtom = atom((get): readonly SettingsSection[] =>
  get(runningPluginsAtom)
    .filter(({ info }) => (info.settings ?? []).length > 0)
    .map(({ info }) => ({
      id: `${info.id}-settings`,
      label: info.label,
      headings: [],
      files: [PLUGINS_FILE, PLUGINS_LOCAL_FILE],
      Component: () => <PluginSettingsSection info={info} />,
    })),
)

/** Every section there is in the open vault. */
export const settingsSectionsAtom = atom((get): readonly SettingsSection[] => [
  ...VAULT_CONTENT,
  ...get(pluginOwnSettingsAtom),
  ...get(pluginSettingsSectionsAtom),
  ...VAULT_AND_ACCOUNT,
])

export const DEFAULT_SECTION_ID = VAULT_CONTENT[0]!.id
