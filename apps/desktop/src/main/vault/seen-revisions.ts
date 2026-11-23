import { isRemote, isLocalOnlyPath, isInIgnoredDir, vaultRelPath } from '@holi/shared'
import { isNonContentPath } from './vault-files'
import { jsonFileStore } from '../json-file-store'

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

export interface SeenRevision {
  seen: string
  previous: string | null
}

interface State {
  version: 1
  remotes: Record<string, Record<string, SeenRevision>>
}

function empty(): State {
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

function parse(raw: unknown, text: string | null): State {
  if (text === null) return empty()
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
  const result = empty()
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

/** Durable per-vault displayed-revision checkpoints. A supplied revision is recorded as-is; HEAD is never sampled here. */
export function createSeenRevisions(file: string) {
  const store = jsonFileStore<State>(file, parse, { mode: 0o600 })
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
    ): Promise<SeenRevision> {
      if (
        !isRemote(remote) ||
        !validPath(path) ||
        typeof revision !== 'string' ||
        !SHA.test(revision)
      )
        throw new Error('Invalid seen revision or path.')
      let answer: SeenRevision | undefined
      await store.update(async (state) => {
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
      })
      return answer!
    },
  }
}
