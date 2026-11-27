import type { ReactNode } from 'react'
import { useShortcutDispatcher } from '@/hooks/use-shortcuts'
import { useShellShortcuts, type ShellActions } from '@/features/shell/use-shell-shortcuts'

const NO_APPS: ShellActions['apps'] = []

/** The shell's real keyboard handling around a plugin view, without unrelated shell effects. */
export function ShellShortcutHost({
  children,
  ...actions
}: Pick<ShellActions, 'tabIds' | 'activeTabId' | 'app' | 'selectTab'> & {
  children: ReactNode
}) {
  useShortcutDispatcher()
  useShellShortcuts({
    ...actions,
    apps: NO_APPS,
    open: () => {},
    closeTab: () => {},
    closeAllTabs: () => {},
    reopenTab: () => {},
    splitRight: () => {},
    newDocument: () => {},
    toggleFiles: () => {},
    showFiles: () => {},
    openApp: () => {},
    setSearchOpen: () => {},
  })
  return children
}
