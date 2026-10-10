/**
 * A plugin's own window (`RendererPlugin.pages`, `main/page-windows.ts`): the
 * one page its URL names, `?page=<plugin>/<page>`, and nothing of the app
 * around it. No vault subscription, no Shell, no flush answer (only the main
 * window holds buffers), no report to main of what is focused.
 */
import type { RendererPlugin } from '@/plugin-api'

/** The page a window's URL names, as `[plugin, page]`, or null for the main
 *  window. */
export function pageFromLocation(search: string): [string, string] | null {
  const value = new URLSearchParams(search).get('page')
  const match = value === null ? null : /^([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/.exec(value)
  return match === null ? null : [match[1]!, match[2]!]
}

export function PageRoot({
  plugins,
  page,
}: {
  plugins: readonly RendererPlugin[]
  page: [string, string]
}): React.JSX.Element | null {
  const [pluginId, name] = page
  const Page = plugins.find((p) => p.info.id === pluginId)?.pages?.[name]
  return Page === undefined ? null : <Page />
}
