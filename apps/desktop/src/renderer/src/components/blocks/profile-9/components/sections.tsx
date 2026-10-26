/**
 * Settings' pages, in the groups the nav shows them under: the vault's, then
 * every running plugin's own (Google's Connections), then this machine's and
 * the account's. The nav and the page both read `settingsGroupsAtom`, so a
 * page is one entry here, or a plugin's `settingsSections`, and nothing else.
 */
import { atom } from "jotai"
import type { ComponentType } from "react"

import type { IconGlyph } from "@/primitives"
import { runningPluginsAtom } from "@/state/plugins"
import {
  CableIcon,
  GitCommitHorizontalIcon,
  HardDriveIcon,
  PaletteIcon,
  PenLineIcon,
  PuzzleIcon,
  RefreshCwIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react"

import { AccountPage, AppearancePage, UpdatesPage } from "./app-pages"
import { PluginsPage } from "./plugins-page"
import { SettingsCard } from "./settings-kit"
import {
  CommitsPage,
  EditorPage,
  GeneralPage,
  MembersPage,
} from "./vault-pages"

export type SettingsPage = {
  id: string
  label: string
  icon: IconGlyph
  description: string
  Component: ComponentType<{ remote: string }>
}

export type SettingsGroup = {
  id: string
  label: string
  pages: readonly SettingsPage[]
}

const VAULT: SettingsGroup = {
  id: "vault",
  label: "Vault",
  pages: [
    {
      id: "general",
      label: "General",
      icon: HardDriveIcon,
      description: "What this vault is, where it lives and how it syncs.",
      Component: GeneralPage,
    },
    {
      id: "members",
      label: "Members",
      icon: UsersIcon,
      description: "Who can open this vault, as GitHub sees it.",
      Component: MembersPage,
    },
    {
      id: "editor",
      label: "Editor",
      icon: PenLineIcon,
      description: "How notes read and what the editor does as you type.",
      Component: EditorPage,
    },
    {
      id: "commits",
      label: "Commits",
      icon: GitCommitHorizontalIcon,
      description: "What happens to your work as it is saved.",
      Component: CommitsPage,
    },
  ],
}

const APP: SettingsGroup = {
  id: "app",
  label: "This machine",
  pages: [
    {
      id: "appearance",
      label: "Appearance",
      icon: PaletteIcon,
      description: "Theme and transparency, on this machine only.",
      Component: AppearancePage,
    },
    {
      id: "updates",
      label: "Updates",
      icon: RefreshCwIcon,
      description: "Holi's own version, and how it starts.",
      Component: UpdatesPage,
    },
  ],
}

const ACCOUNT: SettingsGroup = {
  id: "account",
  label: "Account",
  pages: [
    {
      id: "account",
      label: "GitHub",
      icon: UserRoundIcon,
      description: "Who you are signed in as.",
      Component: AccountPage,
    },
  ],
}

/** Every group in the open vault: Plugins carries the switch per plugin and
 *  each running plugin's own pages. */
export const settingsGroupsAtom = atom((get): readonly SettingsGroup[] => {
  const owned = get(runningPluginsAtom).flatMap((plugin) =>
    (plugin.settingsSections ?? []).map((section) => ({
      info: plugin.info,
      section,
    }))
  )
  const nested = owned
    .filter(({ section }) => section.within === "plugins")
    .map(({ section }) => section)
  const plugins: SettingsGroup = {
    id: "plugins",
    label: "Plugins",
    pages: [
      {
        id: "plugins",
        label: "Plugins",
        icon: PuzzleIcon,
        description: "What this vault runs beyond the core.",
        Component: ({ remote }) => (
          <PluginsPage nested={nested} remote={remote} />
        ),
      },
      // A plugin's own page draws what it likes inside one card, titled with
      // the plugin's name and what it is.
      ...owned
        .filter(({ section }) => section.within === undefined)
        .map(({ info, section }) => ({
          id: section.id,
          label: section.label,
          icon: section.icon ?? CableIcon,
          description: section.description ?? "",
          Component: ({ remote }: { remote: string }) => (
            <SettingsCard title={info.label} description={info.description}>
              <div className="px-4 py-3">
                <section.Component remote={remote} />
              </div>
            </SettingsCard>
          ),
        })),
    ],
  }
  return [VAULT, plugins, APP, ACCOUNT]
})

/** The page `id` names, or the first when it names none (a plugin turned off
 *  while its page was open). */
export function pageFor(
  groups: readonly SettingsGroup[],
  id: string | null
): SettingsPage {
  const pages = groups.flatMap((group) => group.pages)
  return pages.find((page) => page.id === id) ?? pages[0]!
}
