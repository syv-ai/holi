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

export const RENDERER_PLUGINS: readonly RendererPlugin[] = [
  agentRenderer,
  agentUiRenderer,
  pdfRenderer,
  googleRenderer,
  appsRenderer,
]
