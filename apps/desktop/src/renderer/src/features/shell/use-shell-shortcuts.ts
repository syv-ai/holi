import { atom, useAtom, useAtomValue, useSetAtom } from "jotai"
import { useMemo } from "react"
import { toast } from "sonner"

import type { SidebarApp } from "@/plugin-api"
import { newAgentSessionAtom } from "@/state/agents-slots"
import { ensureTodaysDailyAtom } from "@/state/daily"
import { runningPluginsAtom } from "@/state/plugins"
import { shortcutsDialogOpenAtom, useShortcutHandlers } from "@/state/shortcuts"
import { sidebarSectionAtom } from "@/state/sidebar-section"
import { BOARD_TAB } from "../sidebar/documents-section"

/** What the shell can do, for its keys (`lib/shortcuts.ts`). */
export interface ShellActions {
  /** The strip's entries (a split is one), and the view in front: the
   *  active tab, or the active split's focused member. ⌘W closes that. */
  tabIds: readonly string[]
  activeTabId: string | null
  // Split tabs (docs/features/tabs-panes.md): the fields below are optional
  // so a shell without split view keeps compiling.
  /** The active entry's id, which next/previous step from; `activeTabId`
   *  when absent. */
  activeEntryId?: string | null
  /** A New tab, or the Agents home on the Agents side (⌘T). */
  newTab?: () => void
  /** Every member of the active split back to a tab of its own (⇧⌘\);
   *  undefined without an active split. */
  separate?: () => void
  /** Focus the active split's member `step` places on; undefined without
   *  an active split. */
  stepMember?: (step: number) => void
  /** The app in the focused tab (Mail, Calendar), or null for the files. */
  app: string | null
  apps: readonly SidebarApp[]
  open: (id: string) => void
  selectTab: (id: string) => void
  closeTab: (id: string) => void
  closeAllTabs: () => void
  reopenTab: () => void
  /** Split view (⌘\): the active tab and a New tab side by side. */
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
  const [section, setSection] = useAtom(sidebarSectionAtom)
  const newAgentSession = useSetAtom(newAgentSessionAtom)
  const ensureDaily = useSetAtom(ensureTodaysDailyAtom)
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

  /** ⌘B shows or hides the files sidebar, in an app as anywhere: the app
   *  stays in front either way. */
  function toggleSidebar() {
    shell.toggleFiles()
  }
  /** The entry `step` places from the active one, wrapping. */
  function stepTab(step: number) {
    if (tabIds.length === 0) return
    const current =
      shell.activeEntryId === undefined ? activeTabId : shell.activeEntryId
    const at = current === null ? -1 : tabIds.indexOf(current)
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
    "sidebar.toggle": toggleSidebar,
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
    // Inside a split `activeTabId` is the focused member, so ⌘W closes that
    // one, and a 2-split it leaves turns back into a tab.
    "tab.close": () => {
      if (activeTabId !== null) shell.closeTab(activeTabId)
    },
    "tab.closeAll": shell.closeAllTabs,
    "tab.reopen": shell.reopenTab,
    "pane.split": shell.splitRight,
    // Split tabs: ⌘T, separate, and the members' focus.
    "tab.new": shell.newTab,
    "split.separate": shell.separate,
    "split.next":
      shell.stepMember === undefined ? undefined : () => shell.stepMember?.(1),
    "split.previous":
      shell.stepMember === undefined ? undefined : () => shell.stepMember?.(-1),
    // ⌘N is the side's own new: a session on the Agents side (the mode's
    // `newSession`), a document on the Documents side.
    "document.new": () => {
      if (section === "agents" && hasAgents && newAgentSession()) return
      shell.newDocument()
    },
    "daily.open": () => {
      ensureDaily().then(
        (path) => {
          if (path !== null) shell.open(path)
        },
        () =>
          toast.error(
            "Couldn’t open today’s note. Check that the vault is reachable, then try again."
          )
      )
    },
    "session.new": hasAgents ? () => void newAgentSession() : undefined,
    "app.mail": app("mail"),
    "app.calendar": app("calendar"),
  })
}
