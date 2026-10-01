/**
 * Every plugin's main side, in this build. Imported only by the composition
 * root (`src/main/index.ts`); `src/plugins/renderer.ts` must name the same ids.
 */
import type { MainPlugin } from '../main/plugin-api'
import { appsMain } from './apps/main'
import { googleMain } from './google/main'
import { pdfMain } from './pdf/main'

export const MAIN_PLUGINS: readonly MainPlugin[] = [pdfMain, googleMain, appsMain]
