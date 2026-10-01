/**
 * The only core module a plugin's renderer side imports, besides
 * `@/primitives` and `@/composites` (docs/architecture.md, Plugins).
 *
 * One reviewable list of what plugins may reach in core, re-exported from
 * where it lives. ESLint holds plugins to it, and holds core to never
 * importing a plugin (only `main.tsx` installs the list).
 */
export type { ClaimMenuItem, PathClaim, RendererPlugin } from './types'
export type { PluginInfo } from '@holi/shared'

export { trpc } from '@/lib/trpc'
export { capClient, type CapClient } from '@/lib/cap-client'
export { cn } from '@/lib/cn'
export { DRAWER_WIDTH } from '@/lib/drawer'
export { activeRemoteAtom, snapshotAtom } from '@/state/vaults'
export { sessionAtom } from '@/state/session'
export { activeModeAtom } from '@/state/color-scheme'
export { openNoteTabAtom } from '@/state/panes'
export { openDialogAtom, type ActiveDialog } from '@/state/dialogs'
export { askPrompt } from '@/editor/askAgent'
export { askTargetsAtom, defaultAgentTargetAtom, type AgentTarget } from '@/state/agent'
export { sendToAgentAtom } from '@/state/agent-send'
