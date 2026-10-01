/**
 * Every plugin's main side, in this build. Imported only by the composition
 * root (`src/main/index.ts`); `src/plugins/renderer.ts` must name the same ids.
 */
import type { MainPlugin } from '../main/plugin-api'

export const MAIN_PLUGINS: readonly MainPlugin[] = []
