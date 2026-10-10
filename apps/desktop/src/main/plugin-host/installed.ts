/**
 * The plugins this build has, filled once at boot by the composition root
 * from `src/plugins/main.ts`. Held here so core modules that need only the
 * list (the settings writer, which lists every plugin) do not import plugins.
 */
import { checkPluginCatalogue, type PluginInfo } from '@holi/shared'
import type { MainPlugin } from '../plugin-api'

let installed: readonly MainPlugin[] = []

/** Set the list. Throws on a list that could not work: what
 *  `checkPluginCatalogue` refuses, or a seed contributed under another
 *  plugin's name. */
export function install(plugins: readonly MainPlugin[]): void {
  checkPluginCatalogue(plugins.map((p) => p.info))
  for (const { info, seed } of plugins) {
    if (seed !== undefined && seed.id !== info.id) {
      throw new Error(`plugin ${info.id} seeds as ${seed.id}`)
    }
  }
  installed = plugins
}

export const installedPlugins = (): readonly MainPlugin[] => installed

export const installedInfos = (): PluginInfo[] => installed.map((p) => p.info)
