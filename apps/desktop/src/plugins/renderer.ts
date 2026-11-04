/**
 * Every plugin's renderer side, in this build. Imported only by
 * `src/renderer/src/main.tsx`; `src/plugins/main.ts` must name the same ids.
 */
import type { RendererPlugin } from '@/plugin-api'
import { agentRenderer } from './agent/renderer'
import { automationsRenderer } from './automations/renderer'
import { holisRenderer } from './holis/renderer'
import { appsRenderer } from './apps/renderer'
import { communityRenderer } from './community/renderer'
import { googleRenderer } from './google/renderer'
import { browserRenderer } from './browser/renderer'
import { linksRenderer } from './links/renderer'
import { pdfRenderer } from './pdf/renderer'
import { tasksRenderer } from './tasks/renderer'

export const RENDERER_PLUGINS: readonly RendererPlugin[] = [
  agentRenderer,
  automationsRenderer,
  holisRenderer,
  tasksRenderer,
  pdfRenderer,
  linksRenderer,
  browserRenderer,
  googleRenderer,
  appsRenderer,
  communityRenderer,
]
