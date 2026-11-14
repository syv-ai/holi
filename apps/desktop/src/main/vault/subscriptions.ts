import { stat } from 'node:fs/promises'
import { exactPath } from '@holi/shared/path-safety-node'
import { isRemote, isSecretPath, vaultRelPath } from '@holi/shared'
import { jsonFileStore } from '../json-file-store'

export interface SubscriptionScope {
  path: string
  baseline: string | null
}

export interface SubscriptionFile {
  version: 1
  remotes: Record<string, SubscriptionScope[]>
}

export interface SubscriptionView {
  path: string
  explicit: boolean
  coveredBy: string | null
  baseline: string | null
}

const empty = (): SubscriptionFile => ({ version: 1, remotes: {} })

function parseSubscription(raw: unknown, text: string | null): SubscriptionFile {
  if (text === null) return empty()
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    (raw as { version?: unknown }).version !== 1 ||
    typeof (raw as { remotes?: unknown }).remotes !== 'object' ||
    (raw as { remotes?: unknown }).remotes === null
  )
    throw new Error('Subscription state is invalid; it was not changed.')
  const remotes = (raw as { remotes: Record<string, unknown> }).remotes
  const result: SubscriptionFile = empty()
  for (const [remote, scopes] of Object.entries(remotes)) {
    if (!isRemote(remote) || !Array.isArray(scopes))
      throw new Error('Subscription state is invalid; it was not changed.')
    const seen = new Set<string>()
    result.remotes[remote] = scopes.map((scope) => {
      if (scope === null || typeof scope !== 'object' || Array.isArray(scope))
        throw new Error('Subscription state is invalid; it was not changed.')
      const { path, baseline } = scope as { path?: unknown; baseline?: unknown }
      const normalized = path === '' ? '' : vaultRelPath(typeof path === 'string' ? path : '')
      if (
        (path !== '' && normalized !== path) ||
        isSecretPath(normalized) ||
        seen.has(normalized) ||
        (baseline !== null &&
          (typeof baseline !== 'string' || !/^[0-9a-f]{40,64}$/i.test(baseline)))
      )
        throw new Error('Subscription state is invalid; it was not changed.')
      seen.add(normalized)
      return { path: normalized, baseline: baseline as string | null }
    })
  }
  return result
}

/** Machine-local explicit scopes. Reads and updates always use the validated,
 * serialized JsonFileStore; enabling only captures HEAD when not already saved. */
export function createSubscriptions(file: string) {
  const store = jsonFileStore<SubscriptionFile>(file, parseSubscription)

  async function validateScope(root: string, path: string): Promise<string> {
    if (path === '') return ''
    const normalized = vaultRelPath(path)
    if (normalized !== path || isSecretPath(normalized))
      throw new Error('This folder cannot be subscribed.')
    const resolved = await exactPath(root, normalized)
    if (resolved === null || !(await stat(resolved)).isDirectory())
      throw new Error('This folder no longer exists at that path. Refresh the file tree and retry.')
    return normalized
  }

  return {
    async list(remote: string, root: string, paths: string[]) {
      if (!isRemote(remote)) throw new Error('Invalid vault remote.')
      const valid = await Promise.all(paths.map((path) => validateScope(root, path)))
      const saved = (await store.read()).remotes[remote] ?? []
      return valid.map((path): SubscriptionView => {
        const own = saved.find((scope) => scope.path === path)
        const parent = saved
          .filter(
            (scope) =>
              scope.path !== path && scope.path !== '' && path.startsWith(`${scope.path}/`),
          )
          .sort((a, b) => b.path.length - a.path.length)[0]
        const rootScope = saved.find((scope) => scope.path === '')
        const coveredBy = parent?.path ?? (path !== '' ? (rootScope ? '' : null) : null)
        return {
          path,
          explicit: own !== undefined,
          coveredBy,
          baseline: own?.baseline ?? null,
        }
      })
    },
    async set(
      remote: string,
      root: string,
      path: string,
      enabled: boolean,
      head: () => Promise<string | null>,
    ) {
      if (!isRemote(remote)) throw new Error('Invalid vault remote.')
      const normalized = await validateScope(root, path)
      const existing = (await store.read()).remotes[remote]?.find(
        (scope) => scope.path === normalized,
      )
      if (enabled && existing !== undefined) return existing
      if (!enabled && existing === undefined) return null
      const baseline = enabled ? await head() : null
      let outcome: SubscriptionScope | null = null
      await store.update((current) => {
        const scopes = current.remotes[remote] ?? []
        const found = scopes.find((scope) => scope.path === normalized)
        if (enabled && found !== undefined) {
          outcome = found
          return current
        }
        const next = enabled
          ? [...scopes, { path: normalized, baseline }]
          : scopes.filter((scope) => scope.path !== normalized)
        outcome = enabled ? (next[next.length - 1] ?? null) : null
        return { ...current, remotes: { ...current.remotes, [remote]: next } }
      })
      return outcome
    },
  }
}
