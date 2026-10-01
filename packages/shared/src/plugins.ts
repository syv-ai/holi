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
