import { readFileSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { exactPath } from '@holi/shared/path-safety-node'
import { isRemote, isSecretPath, isLocalOnlyPath, isInIgnoredDir, vaultRelPath } from '@holi/shared'
import { isNonContentPath } from './vault-files'
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
    (raw as { remotes?: unknown }).remotes === null ||
    Array.isArray((raw as { remotes?: unknown }).remotes)
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
          (typeof baseline !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseline)))
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
      throw new Error('This path cannot be subscribed.')
    const resolved = await exactPath(root, normalized)
    if (resolved === null) {
      throw new Error(
        'This path no longer exists at that location. Refresh the file tree and retry.',
      )
    }
    const entry = await stat(resolved)
    if (!entry.isDirectory() && !entry.isFile())
      throw new Error('Only files and folders can be subscribed.')
    return normalized
  }

  return {
    /** Fail closed at a synchronous publication point, never from an async snapshot. */
    hasExplicitNow(remote: string): boolean {
      if (!isRemote(remote)) return false
      try {
        const text = readFileSync(file, 'utf8')
        return (parseSubscription(JSON.parse(text), text).remotes[remote]?.length ?? 0) > 0
      } catch {
        return false
      }
    },
    async scope(remote: string, path: string): Promise<SubscriptionScope | null> {
      if (!isRemote(remote)) throw new Error('Invalid vault remote.')
      const normalized = path === '' ? '' : vaultRelPath(path)
      if (normalized !== path || isSecretPath(normalized))
        throw new Error('This path cannot be subscribed.')
      return (await store.read()).remotes[remote]?.find((scope) => scope.path === path) ?? null
    },
    coveringScopeNow(
      remote: string,
      path: string,
    ): {
      scope: SubscriptionScope | null
      isCurrent: () => boolean
    } | null {
      if (!isRemote(remote) || !validPath(path)) return null
      try {
        const text = readFileSync(file, 'utf8')
        const scopes = parseSubscription(JSON.parse(text), text).remotes[remote] ?? []
        const scope =
          scopes
            .filter(
              (item) => item.path === path || item.path === '' || path.startsWith(`${item.path}/`),
            )
            .sort((a, b) => b.path.length - a.path.length)[0] ?? null
        const identity = statSync(file, { bigint: true })
        const fingerprint = `${identity.dev}:${identity.ino}:${identity.mtimeNs}:${identity.size}`
        return {
          scope,
          isCurrent: () => {
            try {
              const current = statSync(file, { bigint: true })
              return (
                `${current.dev}:${current.ino}:${current.mtimeNs}:${current.size}` === fingerprint
              )
            } catch {
              return false
            }
          },
        }
      } catch {
        return null
      }
    },
    async hasExplicit(remote: string): Promise<boolean> {
      if (!isRemote(remote)) return false
      return ((await store.read()).remotes[remote]?.length ?? 0) > 0
    },
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
      let outcome: SubscriptionScope | null = null
      await store.update(async (current) => {
        const normalized = await validateScope(root, path)
        const scopes = current.remotes[remote] ?? []
        const existing = scopes.find((scope) => scope.path === normalized)
        if (enabled && existing !== undefined) {
          outcome = existing
          return current
        }
        if (!enabled && existing === undefined) {
          outcome = null
          return current
        }
        const baseline = enabled ? await head() : null
        if (baseline !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseline))
          throw new Error('Git returned an invalid HEAD revision.')
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

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

interface SeenRevision {
  seen: string
  previous: string | null
}

interface State {
  version: 1
  remotes: Record<string, Record<string, SeenRevision>>
}

function emptySeenState(): State {
  return { version: 1, remotes: {} }
}

function validPath(path: string): boolean {
  try {
    return (
      vaultRelPath(path) === path &&
      !isNonContentPath(path) &&
      !isLocalOnlyPath(path) &&
      !isInIgnoredDir(path) &&
      path !== '.holi' &&
      !path.startsWith('.holi/')
    )
  } catch {
    return false
  }
}

function parseSeenState(raw: unknown, text: string | null): State {
  if (text === null) return emptySeenState()
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    (raw as State).version !== 1 ||
    !(raw as State).remotes ||
    typeof (raw as State).remotes !== 'object' ||
    Array.isArray((raw as State).remotes)
  )
    throw new Error('Seen-revision state is invalid; it was not changed.')
  const result = emptySeenState()
  for (const [remote, files] of Object.entries((raw as State).remotes)) {
    if (!isRemote(remote) || !files || typeof files !== 'object' || Array.isArray(files))
      throw new Error('Seen-revision state is invalid; it was not changed.')
    const entries: Record<string, SeenRevision> = Object.create(null)
    for (const [path, value] of Object.entries(files)) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Seen-revision state is invalid; it was not changed.')
      const item = value as SeenRevision
      if (
        typeof item.seen !== 'string' ||
        !SHA.test(item.seen) ||
        (item.previous !== null && (typeof item.previous !== 'string' || !SHA.test(item.previous)))
      )
        throw new Error('Seen-revision state is invalid; it was not changed.')
      if (!validPath(path)) throw new Error('Seen-revision state is invalid; it was not changed.')
      entries[path] = {
        seen: item.seen.toLowerCase(),
        previous: item.previous?.toLowerCase() ?? null,
      }
    }
    result.remotes[remote] = entries
  }
  return result
}

/** Durable per-vault displayed-revision checkpoints. A supplied revision is recorded as-is; HEAD is never sampled here.
 * @public Storage interface exercised by tests; displayed-content integration uses this seam.
 */
export function createSeenRevisions(file: string) {
  const store = jsonFileStore<State>(file, parseSeenState, { mode: 0o600 })
  async function read(remote: string): Promise<ReadonlyMap<string, SeenRevision>> {
    if (!isRemote(remote)) throw new Error('Invalid vault remote.')
    const state = await store.read()
    return new Map(Object.entries(state.remotes[remote] ?? {}))
  }
  return {
    read,
    async get(remote: string, path: string): Promise<SeenRevision | null> {
      if (!validPath(path)) throw new Error('This path cannot have a seen revision.')
      return (await read(remote)).get(path) ?? null
    },
    async acknowledge(
      remote: string,
      path: string,
      revision: string,
      isAncestor: (ancestor: string, descendant: string) => Promise<boolean>,
      ownership?: {
        stillOwned?: () => boolean | Promise<boolean>
        publishOwned?: () => boolean
      },
    ): Promise<SeenRevision> {
      if (
        !isRemote(remote) ||
        !validPath(path) ||
        typeof revision !== 'string' ||
        !SHA.test(revision)
      )
        throw new Error('Invalid seen revision or path.')
      let answer: SeenRevision | undefined
      await store.update(
        async (state) => {
          const files = state.remotes[remote] ?? Object.create(null)
          const normalizedRevision = revision.toLowerCase()
          const current = Object.hasOwn(files, path) ? files[path] : undefined
          if (current?.seen === normalizedRevision) {
            answer = current
            return state
          }
          if (current && !(await isAncestor(current.seen, normalizedRevision))) {
            if (await isAncestor(normalizedRevision, current.seen)) {
              answer = current
              return state
            }
            throw new Error(
              'Seen revision history diverged or is unavailable; review state was not changed.',
            )
          }
          answer = { seen: normalizedRevision, previous: current?.seen ?? null }
          const updatedFiles = Object.assign(Object.create(null), files, { [path]: answer })
          const remotes = Object.assign(Object.create(null), state.remotes, {
            [remote]: updatedFiles,
          })
          return { ...state, remotes }
        },
        ownership?.stillOwned,
        ownership?.publishOwned,
      )
      return answer!
    },
  }
}
