/**
 * The only core module a plugin's renderer side imports, besides
 * `@/primitives` and `@/composites` (docs/architecture.md, Plugins).
 *
 * One reviewable list of what plugins may reach in core, re-exported from
 * where it lives. ESLint holds plugins to it, and holds core to never
 * importing a plugin (only `main.tsx` installs the list).
 */
export type {
  AgentService,
  AgentServiceSource,
  AgentSessionRow,
  AskResult,
  AskTargets,
  ClaimCreate,
  ClaimDecoration,
  ClaimMenuItem,
  FolderClaim,
  PathClaim,
  PluginEventHandler,
  PluginStore,
  RailItem,
  RendererPlugin,
  SettingsSection,
  SettingsSectionHeading,
  Surface,
} from './types'
export type { PluginInfo } from '@holi/shared'

export { trpc } from '@/lib/trpc'
export { capClient, type CapClient, type UiCapability } from '@/lib/cap-client'
export { useHasCapability } from '@/state/capabilities'
export { cn } from '@/lib/cn'
export { DRAWER_WIDTH } from '@/lib/drawer'
export { activeRemoteAtom, historyEpochsAtom, snapshotAtom, syncStateAtom } from '@/state/vaults'
export { sessionAtom } from '@/state/session'
export { activeModeAtom } from '@/state/color-scheme'
export { openNoteTabAtom } from '@/state/panes'
export {
  closeSurfaceTabAtom,
  closeSurfaceTabsAtom,
  openPathAtom,
  openSurfaceAtom,
  surfaceTabIdsAtom,
  tabForPathAtom,
} from '@/state/surfaces'
export { agentSessionRowsAtom, useAgentService } from '@/state/agent-service'
export { surfacesAtom } from '@/state/plugins'
export { byRecency, recentsAtom } from '@/state/recents'
export { openCommitInHistoryAtom } from '@/state/history'
export { openDialogAtom, type ActiveDialog, type PluginDialog } from '@/state/dialogs'
export { askPrompt } from '@/editor/askAgent'
export { useGlobalPanelLayout } from '@/state/preferences'
export { matchHotkey } from '@/lib/hotkey'
export { plainMarkdownExtensions } from '@/editor/extensions'
