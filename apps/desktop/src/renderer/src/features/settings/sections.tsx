/**
 * The settings tab's sections, in rail order.
 *
 * The rail, the section view and the narrow-pane picker all read this list, so
 * adding a section is adding an entry here and nothing else.
 *
 * `headings` is what the rail shows beneath the section you are in. They are
 * **declared** rather than scraped from the DOM, which could only happen after
 * render. Declaring them means the rail and content can drift, so a test
 * asserts every declared heading renders. A section with no headings does not
 * expand.
 */
import {
  ICONS_FILE,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  THEME_FILE,
  THEME_LOCAL_FILE,
  THEME_TOKEN_GROUPS,
} from '@holi/shared'
import { AccountSection } from './AccountSection'
import { ConnectionsSection } from './ConnectionsSection'
import { DescriptorSection } from './DescriptorSection'
import { IconsSection } from './IconsSection'
import { ThemeSection } from './ThemeSection'
import { VaultSection } from './VaultSection'
import { headingId } from './settings-ui'
import { LIGHT_AND_DARK } from './appearance-headings'
import { COLLABORATORS, WHERE_IT_LIVES } from './vault-headings'

export interface SettingsSectionHeading {
  /** The anchor the rail scrolls to: `headingId(title)`, never hand-written. */
  id: string
  title: string
}

export interface SettingsSection {
  id: string
  label: string
  headings: readonly SettingsSectionHeading[]
  /** The files this section is a view of, offered at the bottom of it. */
  files: readonly string[]
  Component: (props: { remote: string }) => React.JSX.Element
}

const heading = (title: string): SettingsSectionHeading => ({ id: headingId(title), title })

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'general',
    label: 'General',
    headings: [],
    files: [SETTINGS_FILE, SETTINGS_LOCAL_FILE],
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
  {
    id: 'connections',
    label: 'Connections',
    headings: [],
    // Nothing on disk in the vault: a Google grant is the machine's, held by
    // main's credential storage, and the renderer never sees a token.
    files: [],
    Component: () => <ConnectionsSection />,
  },
  {
    id: 'vault',
    label: 'Vault',
    headings: [heading(WHERE_IT_LIVES), heading(COLLABORATORS)],
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
]

export const DEFAULT_SECTION_ID = SETTINGS_SECTIONS[0]!.id
