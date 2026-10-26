/**
 * The only core module a plugin's renderer side imports, besides
 * `@/components` and `@/composites` (docs/architecture.md, Plugins).
 *
 * One reviewable list of what plugins may reach in core, re-exported from
 * where it lives. ESLint holds plugins to it, and holds core to never
 * importing a plugin (only `main.tsx` installs the list).
 */
export type {
  /** @public */ AgentRunFile,
  ArcadeCastMember,
  /** @public */ AgentRunsSource,
  /** @public */ AgentService,
  AgentServiceSource,
  /** @public */ AgentsMode,
  AgentsSessionItem,
  AgentsSessionsSource,
  /** @public */ AgentsSlot,
  AgentsStatus,
  AgentsTabLook,
  AgentSessionRow,
  /** @public */ AskResult,
  AskTargets,
  /** @public */ ClaimCreate,
  /** @public */ ClaimDecoration,
  /** @public */ ClaimMenuItem,
  ConversationContext,
  ConversationStart,
  /** @public */ FolderClaim,
  PathClaim,
  PluginEventHandler,
  PluginStore,
  RailItem,
  RendererPlugin,
  /** @public */ SettingsSection,
  /** @public */ SettingsSectionHeading,
  SidebarApp,
  SlashCommand,
  /** @public */ SlashInput,
  SlashResult,
  /** @public */ StatusItem,
  CommandMenuEntry,
  /** @public */ PaletteItem,
  Surface,
  SurfaceTabLook,
} from './types'
export type { Command } from '@/state/commands'
export type { /** @public */ PluginInfo } from '@holi/shared'

export { trpc } from '@/lib/trpc'
export { capClient, /** @public */ type CapClient, type UiCapability } from '@/lib/cap-client'
export { useHasCapability } from '@/state/capabilities'
export { cn } from '@/lib/cn'
export { /** @public */ openExternal } from '@/lib/open-external'
export { /** @public */ vaultAssetUrl } from '@/lib/vault-asset'
export { useAck } from '@/hooks/use-ack'
export { DRAWER_WIDTH } from '@/lib/drawer'
export {
  activeRemoteAtom,
  historyEpochsAtom,
  snapshotAtom,
  /** @public */ snapshotLoadedAtom,
  syncStateAtom,
  vaultsAtom,
} from '@/state/vaults'
export { openDocumentAtom } from '@/state/open-document'
export { openTabAtom } from '@/state/shell-tabs'
// A sidebar row drags as the tab it opens (docs/features/tabs-panes.md, Drag targets).
export { useTabDrag } from '@/features/shell/use-tab-drag'
export { StatusBarItem } from '@/features/status-bar/status-bar'
export { /** @public */ type TabDescriptor } from '@/state/tab-descriptor'
export { /** @public */ arcadeCastAtom, /** @public */ gridArcadeAtom } from '@/state/grid-arcade'
export {
  /** @public */ ArcadeTakeControl,
  /** @public */ HoliArcade,
} from '@/composites/arcade/holi-arcade'
export { sessionAtom } from '@/state/session'
export { agentProviderSettingAtom, usePluginSetting } from '@/state/settings'
export { activeModeAtom } from '@/state/color-scheme'
export { appModeAtom, /** @public */ type AppMode } from '@/state/app-mode'
export {
  agentsSelectionAtom,
  agentsSlotsAtom,
  /** @public */ type AgentsSelection,
} from '@/state/agents-slots'
export { openNextBeside } from '@/state/alt-open'
export { openNoteTabAtom } from '@/state/panes'
export { openSettingsSectionAtom } from '@/state/settings-section'
export {
  activeSurfaceIdAtom,
  closeSurfaceTabAtom,
  closeSurfaceTabsAtom,
  openPathAtom,
  openSurfaceAtom,
  surfaceTabIdsAtom,
  /** @public */ tabForPathAtom,
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
export {
  openDialogAtom,
  /** @public */ type ActiveDialog,
  /** @public */ type PluginDialog,
} from '@/state/dialogs'
export { askPrompt } from '@/lib/ask-agent'
export { useGlobalPanelLayout } from '@/state/preferences'
export { matchHotkey } from '@/lib/hotkey'
export { DiffView } from '@/composites/diff-view'
export { plainMarkdownExtensions } from '@/editor/extensions'
