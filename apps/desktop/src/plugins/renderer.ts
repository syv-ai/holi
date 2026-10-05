/**
 * Every plugin's renderer side, in this build. Imported only by
 * `src/renderer/src/main.tsx`; `src/plugins/main.ts` must name the same ids.
 */
import type { RendererPlugin } from '@/plugin-api'
import { agentRenderer } from './agent/renderer'
import { agentUiRenderer } from './agent-ui/renderer'
import { appsRenderer } from './apps/renderer'
import { googleRenderer } from './google/renderer'
import { pdfRenderer } from './pdf/renderer'
import { workspaceRenderer } from './workspace-ui/renderer'

export const RENDERER_PLUGINS: readonly RendererPlugin[] = [
  // First: a surface kind goes to the first plugin to name it, and Workspace's agenda and apps
  // replace the ones named by the plugins after it.
  workspaceRenderer,
  agentRenderer,
  agentUiRenderer,
  pdfRenderer,
  googleRenderer,
  appsRenderer,
]
