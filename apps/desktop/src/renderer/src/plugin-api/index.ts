/**
 * The only core module a plugin's renderer side imports, besides
 * `@/primitives` and `@/composites` (docs/architecture.md, Plugins).
 *
 * One reviewable list of what plugins may reach in core, re-exported from
 * where it lives. ESLint holds plugins to it, and holds core to never
 * importing a plugin (only `main.tsx` installs the list).
 */
export type {
  AgentRunFile,
  AgentRunsSource,
  AgentService,
  AgentServiceSource,
  AgentsMode,
  AgentsSlot,
  AgentsStatus,
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
  SidebarApp,
  PaletteItem,
  Surface,
  SurfaceTabLook,
} from './types'
export type { Command } from '@/state/commands'
export type { PluginInfo } from '@holi/shared'

export { trpc } from '@/lib/trpc'
export { capClient, type CapClient, type UiCapability } from '@/lib/cap-client'
export { useHasCapability } from '@/state/capabilities'
export { cn } from '@/lib/cn'
export { useAck } from '@/lib/use-ack'
export { DRAWER_WIDTH } from '@/lib/drawer'
export { activeRemoteAtom, historyEpochsAtom, snapshotAtom, syncStateAtom } from '@/state/vaults'
export { sessionAtom } from '@/state/session'
export { usePluginSetting } from '@/state/settings'
export { activeModeAtom } from '@/state/color-scheme'
export { appModeAtom, type AppMode } from '@/state/app-mode'
export { agentsSelectionAtom, agentsSlotsAtom, type AgentsSelection } from '@/state/agents-slots'
export { openNoteTabAtom } from '@/state/panes'
export { openSettingsSectionAtom } from '@/state/settings-section'
export {
  activeSurfaceIdAtom,
  closeSurfaceTabAtom,
  closeSurfaceTabsAtom,
  openPathAtom,
  openSurfaceAtom,
  surfaceTabIdsAtom,
  tabForPathAtom,
} from '@/state/surfaces'
export {
  agentRunFilesAtom,
  agentRunsReviewedAtom,
  agentSessionRowsAtom,
  keepAgentRunAtom,
  loadAgentRunsAtom,
  reviewAgentRunAtom,
  revertAgentRunAtom,
  showAgentSessionAtom,
  useAgentService,
} from '@/state/agent-service'
export { surfacesAtom } from '@/state/plugins'
export { byRecency, recentsAtom } from '@/state/recents'
export { openCommitInHistoryAtom } from '@/state/history'
export { openDialogAtom, type ActiveDialog, type PluginDialog } from '@/state/dialogs'
export { askPrompt } from '@/editor/askAgent'
export { useGlobalPanelLayout } from '@/state/preferences'
export { matchHotkey } from '@/lib/hotkey'
export { plainMarkdownExtensions } from '@/editor/extensions'
