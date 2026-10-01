/**
 * The URL schemes this build serves: core's and every installed plugin's
 * (`MainPlugin.schemes`). Electron takes them all before the app is ready, so
 * the list is static, and a plugin's handler answers 404 whenever the open
 * vault has that plugin off.
 *
 * No `electron` import: the composition root registers and handles them.
 */
import type { LiveVault, MainPlugin, PluginScheme } from '../plugin-api'

export interface SchemeEntry {
  /** The plugin serving it, or null for core. */
  owner: string | null
  scheme: PluginScheme
}

/** Core's schemes, then each plugin's. Throws when two claim one scheme. */
export function schemeEntries(
  core: readonly PluginScheme[],
  plugins: readonly MainPlugin[],
): SchemeEntry[] {
  const entries: SchemeEntry[] = [
    ...core.map((scheme) => ({ owner: null, scheme })),
    ...plugins.flatMap((p) => (p.schemes ?? []).map((scheme) => ({ owner: p.info.id, scheme }))),
  ]
  const seen = new Set<string>()
  for (const { scheme } of entries) {
    if (seen.has(scheme.scheme)) throw new Error(`scheme ${scheme.scheme} is served twice`)
    seen.add(scheme.scheme)
  }
  return entries
}

/** The schemes whose pages run in frames (`window-guard.ts`). */
export const frameSchemes = (entries: readonly SchemeEntry[]): ReadonlySet<string> =>
  new Set(entries.filter((e) => e.scheme.frame === true).map((e) => e.scheme.scheme))

export interface ServeDeps {
  active(): LiveVault | null
  /** Does the vault at `root` run the plugin `owner`? */
  runs(owner: string, root: string): Promise<boolean>
}

/** A request handler for one entry: a plugin's answers 404 while the open
 *  vault has it off, or no vault is open. */
export function serveScheme(
  entry: SchemeEntry,
  deps: ServeDeps,
): (request: Request) => Promise<Response> {
  const ctx = { active: deps.active }
  return async (request) => {
    if (entry.owner !== null) {
      const vault = deps.active()
      if (vault === null || !(await deps.runs(entry.owner, vault.root))) {
        return new Response(null, { status: 404 })
      }
    }
    return entry.scheme.handle(request, ctx)
  }
}
