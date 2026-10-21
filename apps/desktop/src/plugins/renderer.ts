/**
 * Every plugin's renderer side, in this build. Imported only by
 * `src/renderer/src/main.tsx`; `src/plugins/main.ts` must name the same ids.
 */
import type { RendererPlugin } from '@/plugin-api'
import { agentRenderer } from './agent/renderer'
import { appsRenderer } from './apps/renderer'
import { communityRenderer } from './community/renderer'
import { googleRenderer } from './google/renderer'
import { pdfRenderer } from './pdf/renderer'
import { tasksRenderer } from './tasks/renderer'

export const RENDERER_PLUGINS: readonly RendererPlugin[] = [
  agentRenderer,
  tasksRenderer,
  pdfRenderer,
  googleRenderer,
  appsRenderer,
  communityRenderer,
]
