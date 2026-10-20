/**
 * The plugins this build has, filled once at boot by the composition root
 * from `src/plugins/main.ts`. Held here so core modules that need only the
 * list (the settings writer, which lists every plugin) do not import plugins.
 */
import { checkPluginCatalogue, type PluginInfo } from '@holi/shared'
import type { MainPlugin } from '../plugin-api'
import { seededPaths } from '../vault/seed/seed'

let installed: readonly MainPlugin[] = []

/** Set the list. Throws on a list that could not work: what
 *  `checkPluginCatalogue` refuses, a seed contributed under another plugin's
 *  name, or one that writes under a prefix another plugin owns (`owns`)
 *  without saying it adds to that plugin (`addsTo`). */
export function install(plugins: readonly MainPlugin[]): void {
  checkPluginCatalogue(plugins.map((p) => p.info))
  for (const { info, seed } of plugins) {
    if (seed !== undefined && seed.id !== info.id) {
      throw new Error(`plugin ${info.id} seeds as ${seed.id}`)
    }
  }
  const owned = plugins.flatMap((p) =>
    (p.seed?.owns ?? []).map((prefix) => ({ id: p.info.id, prefix })),
  )
  for (const { info, seed } of plugins) {
    for (const rel of seed === undefined ? [] : seededPaths(seed)) {
      const owner = owned.find((o) => o.id !== info.id && rel.startsWith(o.prefix))
      if (owner !== undefined && !(info.addsTo ?? []).includes(owner.id)) {
        throw new Error(
          `plugin ${info.id} seeds ${rel}, which ${owner.id} owns, without adding to it`,
        )
      }
    }
  }
  installed = plugins
}

export const installedPlugins = (): readonly MainPlugin[] => installed

export const installedInfos = (): PluginInfo[] => installed.map((p) => p.info)
