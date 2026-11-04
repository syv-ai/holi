/**
 * Which of the sidebar's two modes is in front (docs/features/sidebar.md):
 * Documents, writing in the vault, or Agents, the work being done for you.
 * The agent plugin's `agentsMode` supplies the Agents side; core owns the
 * toggle and this atom.
 */
import { atomWithStorage } from 'jotai/utils'

export type AppMode = 'documents' | 'agents'

export const appModeAtom = atomWithStorage<AppMode>('holi.app-mode', 'documents')
