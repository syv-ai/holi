/**
 * Every plugin's renderer side, in this build. Imported only by
 * `src/renderer/src/main.tsx`; `src/plugins/main.ts` must name the same ids.
 */
import type { RendererPlugin } from '@/plugin-api'

export const RENDERER_PLUGINS: readonly RendererPlugin[] = []
