/**
 * What every process knows about a plugin, and the rules for its id.
 *
 * Plugins are first-party modules in the desktop build (`apps/desktop/src/plugins/<id>/`),
 * listed once per process. Each side describes itself with the same
 * `PluginInfo`, so main and the renderer agree on which plugins exist and on
 * what each one defaults to. See docs/architecture.md, Plugins.
 *
 * Pure and browser-safe.
 */

export interface PluginInfo {
  /** Kebab-case, and the namespace of everything the plugin contributes:
   *  capabilities, settings keys, surfaces. */
  id: string
  /** What the settings tab calls it. */
  label: string
  /** Whether a vault that does not mention the plugin runs it. */
  default: boolean
}

const PLUGIN_ID = /^[a-z][a-z0-9-]*$/

/** Is `value` something a plugin could be called? */
export function isPluginId(value: unknown): value is string {
  return typeof value === 'string' && PLUGIN_ID.test(value)
}

/**
 * The `plugins` setting, resolved across the two settings files
 * (docs/features/settings.md). The vault's file says which plugins it runs;
 * this machine's local file can only turn one off.
 */
export interface PluginSettings {
  /** What `app.yaml` answers, by id. Ids no installed plugin has are kept,
   *  and mean nothing here. */
  vault: Record<string, boolean>
  /** What `app.local.yaml` turns off on this machine. */
  localOff: string[]
}

/**
 * The plugins that run: the vault's answer, else the plugin's own default,
 * minus what this machine turned off. A local `true` cannot turn on a plugin
 * the vault has off, so it is never read.
 */
export function enabledPlugins(
  settings: PluginSettings,
  known: readonly PluginInfo[],
): Set<string> {
  const off = new Set(settings.localOff)
  return new Set(
    known.filter((p) => (settings.vault[p.id] ?? p.default) && !off.has(p.id)).map((p) => p.id),
  )
}
