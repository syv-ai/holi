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
  ClaimEditor,
  ClaimFrontmatter,
  ClaimMenuItem,
  FieldControlProps,
  FolderClaim,
  LinkChip,
  MentionGroup,
  MentionItem,
  PathClaim,
  PathMark,
  PluginEventHandler,
  PluginStore,
  RailItem,
  RendererPlugin,
  SettingsSection,
  SettingsSectionHeading,
  PaletteItem,
  Surface,
  SurfaceTabLook,
} from './types'
export type { Command } from '@/state/commands'
export type { SlashCommand, SlashInput, SlashResult } from '@/editor/slash'
export type { Tab } from '@/state/panes'
export type { PluginInfo } from '@holi/shared'

export { trpc } from '@/lib/trpc'
export { capClient, type CapClient, type UiCapability } from '@/lib/cap-client'
export { useHasCapability } from '@/state/capabilities'
export { cn } from '@/lib/cn'
export { useAck } from '@/lib/use-ack'
export { DRAWER_WIDTH } from '@/lib/drawer'
export {
  activeDocAtom,
  activeRemoteAtom,
  historyEpochsAtom,
  loadSnapshotAtom,
  snapshotAtom,
  syncStateAtom,
} from '@/state/vaults'
export { sessionAtom } from '@/state/session'
export { usePluginSetting } from '@/state/settings'
export { activeModeAtom } from '@/state/color-scheme'
export {
  activeTab,
  closeTabsForPaths,
  openBesideAtom,
  openNoteTabAtom,
  workspaceAtom,
} from '@/state/panes'
export { nowAtom, todayAtom } from '@/state/clock'
export { memberLoginsAtom, peopleList } from '@/state/members'
export { useEditorDeps } from '@/state/editor-deps'
export { duePresets, reminderPresets, shortStamp } from '@/lib/date-presets'
export { useArrivals } from '@/lib/use-arrivals'
export { requestArrivalAtom, type Arrival } from '@/state/arrival'
export {
  activeSurfaceIdAtom,
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
export { baseEditorExtensions, plainMarkdownExtensions } from '@/editor/extensions'
