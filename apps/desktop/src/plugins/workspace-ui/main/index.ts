/**
 * Workspace's main side: nothing but its name. What it changes is drawn by the
 * renderer (docs/features/nav-menu.md).
 */
import type { MainPlugin } from '../../../main/plugin-api'
import { WORKSPACE_INFO } from '../info'

export const workspaceMain: MainPlugin = { info: WORKSPACE_INFO }
