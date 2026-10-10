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

import type { TransformToggle } from './vault-settings'

export interface PluginInfo {
  /** Kebab-case, and the namespace of everything the plugin contributes:
   *  capabilities, settings keys, surfaces. */
  id: string
  /** What the settings tab calls it. */
  label: string
  /** Whether a vault that does not mention the plugin runs it. */
  default: boolean
  /** What it is, in a sentence, for the settings tab. What it adds to Holi
   *  (tabs, keys, settings) is listed from its contributions, not restated. */
  description?: string
  /** What turning it off does, including what stays: the settings tab says it
   *  beside the switch, before anyone flips it. */
  whenOff?: string
  /** The plugins it builds on: it runs only where every one of them runs, so
   *  turning one off leaves this off too. */
  requires?: readonly string[]
  /** The commit transforms its main side runs (`MainPlugin.transforms`), as
   *  the settings tab switches them. */
  transforms?: readonly TransformToggle[]
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

/** Why a plugin is or is not running, from the two settings files alone.
 *  Whether it started is the host's business, not this. */
export type PluginStatus =
  | { kind: 'on' }
  /** The vault has it off, or says nothing and its default is off. */
  | { kind: 'off-vault' }
  /** This machine's `app.local.yaml` turns it off. */
  | { kind: 'off-here' }
  /** A plugin it requires is not running, for whatever reason. */
  | { kind: 'needs'; missing: string[] }

export interface PluginResolution {
  /** The ids that run. */
  running: ReadonlySet<string>
  /** Every known plugin's status, in catalogue order. */
  status: ReadonlyMap<string, PluginStatus>
}

/**
 * Which plugins run and why each other one does not: the vault's answer, else
 * the plugin's own default, minus what this machine turned off, minus any
 * plugin whose `requires` are not all running (down a chain: one built on a
 * plugin left off is left off too). A local `true` cannot turn on a plugin the
 * vault has off, so it is never read. Every "is it running" in both processes
 * reads this, so the rule has one home.
 */
export function resolvePlugins(
  settings: PluginSettings,
  known: readonly PluginInfo[],
): PluginResolution {
  const localOff = new Set(settings.localOff)
  const status = new Map<string, PluginStatus>()
  const running = new Set<string>()
  for (const p of known) {
    const kind = !(settings.vault[p.id] ?? p.default)
      ? 'off-vault'
      : localOff.has(p.id)
        ? 'off-here'
        : 'on'
    status.set(p.id, { kind })
    if (kind === 'on') running.add(p.id)
  }
  for (let dropped = true; dropped;) {
    dropped = false
    for (const p of known) {
      if (!running.has(p.id)) continue
      const missing = (p.requires ?? []).filter((id) => !running.has(id))
      if (missing.length === 0) continue
      running.delete(p.id)
      status.set(p.id, { kind: 'needs', missing })
      dropped = true
    }
  }
  return { running, status }
}

/**
 * The plugin list a build hands each process, checked once for what could
 * never work: a bad or repeated id, a requirement this build does not have,
 * or plugins requiring each other in a circle. Main and the renderer both
 * call it at boot, so a broken list fails in either.
 */
export function checkPluginCatalogue(known: readonly PluginInfo[]): void {
  const byId = new Map<string, PluginInfo>()
  for (const p of known) {
    if (!isPluginId(p.id)) throw new Error(`plugin id ${p.id} is not kebab-case`)
    if (byId.has(p.id)) throw new Error(`plugin ${p.id} is installed twice`)
    byId.set(p.id, p)
  }
  for (const p of known) {
    const missing = (p.requires ?? []).filter((id) => !byId.has(id))
    if (missing.length > 0) throw new Error(`plugin ${p.id} requires ${missing.join(', ')}`)
  }
  const done = new Set<string>()
  const visit = (id: string, path: string[]): void => {
    if (done.has(id)) return
    if (path.includes(id))
      throw new Error(`plugins require each other: ${[...path, id].join(' > ')}`)
    for (const next of byId.get(id)?.requires ?? []) visit(next, [...path, id])
    done.add(id)
  }
  for (const p of known) visit(p.id, [])
}

/** Plugin ids as the settings tab names them, joined: "Vault apps and Agent". */
export function pluginLabels(ids: readonly string[], known: readonly PluginInfo[]): string {
  return ids.map((id) => known.find((p) => p.id === id)?.label ?? id).join(' and ')
}
