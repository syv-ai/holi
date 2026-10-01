/**
 * A vault's own commit hooks: the standard `pre-commit` framework's
 * `.pre-commit-config.yaml` (pre-commit.com), committed in the vault and run by
 * Holi's commit path after its built-in transforms. See
 * docs/features/vaults-sync.md.
 *
 * Pure: the file's text in, the hooks that run at commit out, in the order they
 * run. Main runs them; the settings tab lists them from this.
 */
import { parse as parseYaml } from 'yaml'

export const PRE_COMMIT_CONFIG = '.pre-commit-config.yaml'

/** One hook the config runs at commit. */
export interface PreCommitHook {
  id: string
  /** The config's `name`, else the id. */
  name: string
  /** The repo's URL, or `local` / `meta`. */
  repo: string
  /** A `local` hook's command, as written. */
  entry?: string
}

export type PreCommitConfig = { ok: true; hooks: PreCommitHook[] } | { ok: false; error: string }

/** The stage Holi runs, under both its names (`commit` is pre-commit's old one). */
const COMMIT_STAGES = new Set(['pre-commit', 'commit'])

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null

/**
 * The hooks `.pre-commit-config.yaml` runs at commit, in order. A hook whose
 * `stages` (or the file's `default_stages`) leave out the commit stage is not
 * listed, because Holi never runs it. A file pre-commit itself would refuse is
 * `ok: false`, with the reason.
 */
export function parsePreCommitConfig(text: string): PreCommitConfig {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const root = record(doc)
  const repos = root?.['repos']
  if (root === null || !Array.isArray(repos)) {
    return { ok: false, error: 'it has no `repos:` list' }
  }
  const defaultStages = strings(root['default_stages'])
  const hooks: PreCommitHook[] = []
  for (const entry of repos) {
    const repo = record(entry)
    if (repo === null || typeof repo['repo'] !== 'string' || !Array.isArray(repo['hooks'])) {
      return { ok: false, error: 'each repo needs a `repo:` and a `hooks:` list' }
    }
    for (const raw of repo['hooks']) {
      const hook = record(raw)
      if (hook === null || typeof hook['id'] !== 'string') {
        return { ok: false, error: 'each hook needs an `id:`' }
      }
      const stages = strings(hook['stages']) ?? defaultStages
      if (stages !== null && !stages.some((s) => COMMIT_STAGES.has(s))) continue
      hooks.push({
        id: hook['id'],
        name: typeof hook['name'] === 'string' ? hook['name'] : hook['id'],
        repo: repo['repo'],
        ...(typeof hook['entry'] === 'string' ? { entry: hook['entry'] } : {}),
      })
    }
  }
  return { ok: true, hooks }
}

/**
 * What the settings tab shows about a vault's own hooks on this machine. Main
 * answers it (`settings.preCommit`).
 */
export interface PreCommitStatus {
  /** Whether the vault has the file, and whether it parses. */
  config: 'absent' | 'invalid' | 'present'
  /** Why an `invalid` file is refused. */
  error?: string
  hooks: PreCommitHook[]
  /** `pre-commit --version`, or null when it is not installed here. */
  tool: string | null
  /**
   * Whether this person lets the vault's hooks run on this machine: `changed`
   * when they did, for a config (or a local hook's script) that has changed
   * since.
   */
  allowed: 'no' | 'yes' | 'changed'
  /** What an approval is of: send it back with `settings.allowPreCommit`. */
  hash: string | null
  /** The last run this session, if any. */
  lastRun: { at: string; ok: boolean; summary: string } | null
}
