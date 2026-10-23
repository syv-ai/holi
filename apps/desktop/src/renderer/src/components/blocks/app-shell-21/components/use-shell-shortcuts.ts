import { atom, useAtomValue, useSetAtom } from "jotai"
import { useMemo } from "react"

import type { SidebarApp } from "@/plugin-api"
import { runningPluginsAtom } from "@/state/plugins"
import { shortcutsDialogOpenAtom, useShortcutHandlers } from "@/state/shortcuts"
import { sidebarSectionAtom } from "@/state/sidebar-section"
import { BOARD_TAB } from "./documents-section"

/** What the shell can do, for its keys (`lib/shortcuts.ts`). */
export interface ShellActions {
  /** The focused pane's tabs, and its active one: the keys act on it. */
  tabIds: readonly string[]
  activeTabId: string | null
  apps: readonly SidebarApp[]
  open: (id: string) => void
  selectTab: (id: string) => void
  closeTab: (id: string) => void
  closeAllTabs: () => void
  reopenTab: () => void
  /** A new pane beside the focused one (⌘\). */
  splitRight: () => void
  newDocument: () => void
  toggleFiles: () => void
  /** Bring the files sidebar out: leave any app, expand the rail. */
  showFiles: () => void
  openApp: (id: string) => void
  setSearchOpen: (update: (open: boolean) => boolean) => void
}

/** The app shell's handlers for the shortcut table. */
export function useShellShortcuts(shell: ShellActions): void {
  const setDialogOpen = useSetAtom(shortcutsDialogOpenAtom)
  const setSection = useSetAtom(sidebarSectionAtom)
  const hasAgents = useAtomValue(runningPluginsAtom).some(
    (plugin) => plugin.agentsMode !== undefined
  )
  const listedAtom = useMemo(
    () =>
      atom((get) =>
        shell.apps
          .filter((app) => app.visible === undefined || get(app.visible))
          .map((app) => app.id)
      ),
    [shell.apps]
  )
  const listed = useAtomValue(listedAtom)

  const { tabIds, activeTabId } = shell
  /** The tab `step` places from the showing one, wrapping. */
  function stepTab(step: number) {
    if (tabIds.length === 0) return
    const at = activeTabId === null ? -1 : tabIds.indexOf(activeTabId)
    const from = at < 0 ? (step > 0 ? -1 : 0) : at
    const id = tabIds[(from + step + tabIds.length) % tabIds.length]
    if (id !== undefined) shell.selectTab(id)
  }
  function toggleDialog() {
    shell.setSearchOpen(() => false)
    setDialogOpen((open) => !open)
  }
  function showSection(section: "documents" | "agents") {
    setSection(section)
    shell.showFiles()
  }
  function app(id: string) {
    return listed.includes(id) ? () => shell.openApp(id) : undefined
  }

  useShortcutHandlers({
    "shortcuts.show": toggleDialog,
    "shortcuts.toggle": toggleDialog,
    "search.open": () => {
      setDialogOpen(false)
      shell.setSearchOpen((open) => !open)
    },
    "sidebar.toggle": shell.toggleFiles,
    "sidebar.documents": () => showSection("documents"),
    "sidebar.agents": hasAgents ? () => showSection("agents") : undefined,
    "board.open": () => shell.open(BOARD_TAB),
    "tab.next": () => stepTab(1),
    "tab.previous": () => stepTab(-1),
    // ⌘9 is the last tab, as in a browser.
    "tab.goto": (index) => {
      const id = index === 8 ? tabIds[tabIds.length - 1] : tabIds[index]
      if (id !== undefined) shell.selectTab(id)
    },
    // An app (Mail, Calendar) is a tab too: ⌘W puts it away like any other.
    "tab.close": () => {
      if (activeTabId !== null) shell.closeTab(activeTabId)
    },
    "tab.closeAll": shell.closeAllTabs,
    "tab.reopen": shell.reopenTab,
    "pane.split": shell.splitRight,
    "document.new": shell.newDocument,
    "app.mail": app("mail"),
    "app.calendar": app("calendar"),
  })
}
