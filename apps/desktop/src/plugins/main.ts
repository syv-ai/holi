/**
 * Every plugin's main side, in this build. Imported only by the composition
 * root (`src/main/index.ts`); `src/plugins/renderer.ts` must name the same ids.
 */
import type { MainPlugin } from '../main/plugin-api'
import { agentMain } from './agent/main'
import { automationsMain } from './automations/main'
import { holisMain } from './holis/main'
import { chatMain } from './chat/main'
import { appsMain } from './apps/main'
import { communityMain } from './community/main'
import { googleMain } from './google/main'
import { pdfMain } from './pdf/main'

export const MAIN_PLUGINS: readonly MainPlugin[] = [
  agentMain,
  automationsMain,
  holisMain,
  chatMain,
  pdfMain,
  googleMain,
  appsMain,
  communityMain,
]
