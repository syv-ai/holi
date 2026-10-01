/**
 * How the agent merges `.claude/settings.json`: its own base keys, plus the
 * hooks and permission rules every seed contribution adds as fragments.
 *
 * **Merged rather than create-if-missing, and that is a security property.**
 * Most vaults already have a `settings.json`, so write-if-absent would ship
 * the Google send gate as a hook script nothing invokes.
 *
 * Key-wise, the way `.gitignore` is line-wise: an adopted vault's own hooks,
 * rules and keys are not Holi's to replace. Holi adds what is absent and
 * touches nothing else, so a vault that sets a default back (here or in
 * `settings.local.json`) keeps its choice.
 */

/** What a contribution adds to `.claude/settings.json`. */
export interface SettingsFragment {
  /** Hooks, each running `.claude/hooks/<script>.mjs` with `args`. */
  hooks?: { event: string; matcher?: string; script: string; args?: string[] }[]
  /** Rules appended to the vault's own, each only when absent. */
  permissions?: { ask?: string[]; allow?: string[]; deny?: string[] }
}

export const hookScript = (script: string) => `.claude/hooks/${script}.mjs`

const hookCommand = (script: string, args: string[] = []) =>
  [`node "$CLAUDE_PROJECT_DIR/${hookScript(script)}"`, ...args].join(' ')

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** `target` with every key of `base` it lacks, recursing into objects both
 *  have. A value the vault set, whatever it is, stays. */
function fillAbsent(target: Json, base: Json): void {
  for (const [key, value] of Object.entries(base)) {
    if (target[key] === undefined) target[key] = structuredClone(value)
    else if (isObject(target[key]) && isObject(value)) fillAbsent(target[key], value)
  }
}

/**
 * The `settings.json` this vault should have, or **null** if it already
 * carries everything (or cannot be parsed).
 *
 * A malformed file returns `null`: it is the user's, and unparseable JSON is
 * not something to "fix" by overwriting. The cost is an ungated vault.
 *
 * **A hook goes in only where its script is** (`has`, by vault path). Scripts
 * are seeded at creation and updated on request, so a hook a later release adds
 * must not be wired before the update that brings its script: it would fail on
 * every prompt. A hook is present when its event has an entry with the same
 * matcher running the same script, so a vault that reordered or annotated the
 * entry does not get a duplicate.
 */
export function mergeClaudeSettings(
  existing: string | null,
  base: Json,
  fragments: readonly SettingsFragment[],
  has: (rel: string) => boolean,
): string | null {
  let settings: Json = {}
  if (existing !== null && existing.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(existing)
      if (!isObject(parsed)) return null
      settings = parsed
    } catch {
      return null
    }
  }
  const before = JSON.stringify(settings)

  for (const fragment of fragments) {
    for (const hook of fragment.hooks ?? []) {
      if (!has(hookScript(hook.script))) continue
      if (!isObject(settings.hooks)) settings.hooks = {}
      const hooks = settings.hooks as Json
      const entries = Array.isArray(hooks[hook.event]) ? (hooks[hook.event] as unknown[]) : []
      const present = entries.some(
        (entry) =>
          isObject(entry) &&
          entry.matcher === hook.matcher &&
          JSON.stringify(entry.hooks ?? []).includes(hookScript(hook.script)),
      )
      if (present) continue
      hooks[hook.event] = [
        ...entries,
        {
          ...(hook.matcher === undefined ? {} : { matcher: hook.matcher }),
          hooks: [{ type: 'command', command: hookCommand(hook.script, hook.args) }],
        },
      ]
    }
  }

  fillAbsent(settings, base)

  for (const fragment of fragments) {
    for (const kind of ['ask', 'allow', 'deny'] as const) {
      const rules = fragment.permissions?.[kind] ?? []
      if (rules.length === 0) continue
      if (!isObject(settings.permissions)) settings.permissions = {}
      const permissions = settings.permissions as Json
      const have = Array.isArray(permissions[kind]) ? (permissions[kind] as unknown[]) : []
      const missing = rules.filter((rule) => !have.includes(rule))
      if (missing.length > 0) permissions[kind] = [...have, ...missing]
    }
  }

  return JSON.stringify(settings) === before ? null : JSON.stringify(settings, null, 2) + '\n'
}
