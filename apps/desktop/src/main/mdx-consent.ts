import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { MDX_RESOURCE_PURPOSE } from '@holi/shared'
import { isMdxExternalOrigin } from './mdx-external-policy'

const VERSION = 1

/** The trusted main caller supplies the canonical vault root, remote and verified account. */
interface MdxConsentScope {
  origin: string
  root: string
  remote: string
  accountId: string
}

type Grant = { origin: string; revocationPending?: true }

export interface MdxConsentStore {
  allows(scope: MdxConsentScope): Promise<boolean>
  listGrants(owner: Omit<MdxConsentScope, 'origin'>): Promise<Grant[]>
  /** Pass a synchronous lifetime check for a document-bound approval. A retired approval rejects. */
  grant(scope: MdxConsentScope, stillOwned?: () => boolean): Promise<void>
  revoke(scope: MdxConsentScope): Promise<void>
  /** Wait for accepted operations to settle, after closing admission at the caller. */
  drain(): Promise<void>
}

type State = { version: 1; grants: MdxConsentScope[] }

function validScope(value: unknown): value is MdxConsentScope {
  if (!value || typeof value !== 'object') return false
  const { origin, root, remote, accountId } = value as Partial<MdxConsentScope>
  if (
    !isMdxExternalOrigin(origin) ||
    typeof root !== 'string' ||
    typeof remote !== 'string' ||
    typeof accountId !== 'string' ||
    !root ||
    !remote ||
    !accountId
  )
    return false
  return true
}

/** Machine-local, fail-closed HTTPS grants. Main keeps one store instance per file. */
export function createMdxConsentStore(file: string): MdxConsentStore {
  let queue = Promise.resolve()
  const denied = new Set<string>()
  const revocations = new Map<string, { scope: MdxConsentScope; write?: Promise<void> }>()
  const key = (scope: MdxConsentScope) =>
    JSON.stringify([scope.origin, MDX_RESOURCE_PURPOSE, scope.root, scope.remote, scope.accountId])

  const transact = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const read = async (): Promise<State> => {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: VERSION, grants: [] }
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('MDX consent state is corrupt')
    }
    if (
      !value ||
      typeof value !== 'object' ||
      (value as State).version !== VERSION ||
      !Array.isArray((value as State).grants)
    )
      throw new Error('MDX consent state version is unsupported')
    const grants = (value as State).grants
    if (!grants.every(validScope)) throw new Error('MDX consent state is corrupt')
    return { version: VERSION, grants }
  }
  const persist = async (state: State, beforePublish?: () => void) => {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    const handle = await open(temp, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(JSON.stringify(state))
        await handle.sync()
      } finally {
        await handle.close()
      }
      // A queued asynchronous rename could run after ownership expires.
      beforePublish?.()
      renameSync(temp, file)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }
  return {
    async allows(scope) {
      if (!validScope(scope)) return false
      const id = key(scope)
      return transact(async () => {
        if (denied.has(id)) return false
        try {
          const state = await read()
          return !denied.has(id) && state.grants.some((grant) => key(grant) === id)
        } catch {
          return false
        }
      })
    },
    listGrants(owner) {
      return transact(async () => {
        const matches = (scope: MdxConsentScope) =>
          key({ ...owner, origin: scope.origin }) === key(scope)
        const pending = (): Grant[] =>
          [...revocations.values()].flatMap(({ scope }) =>
            matches(scope) ? [{ origin: scope.origin, revocationPending: true }] : [],
          )
        const listed = new Map<string, Grant>()
        try {
          for (const scope of (await read()).grants) {
            if (matches(scope) && !denied.has(key(scope)))
              listed.set(scope.origin, { origin: scope.origin })
          }
        } catch (error) {
          // An unreadable file must not hide the only way to retry a blocked grant.
          if (pending().length === 0) throw error
        }
        for (const grant of pending()) listed.set(grant.origin, grant)
        return [...listed.keys()].sort().map((origin) => listed.get(origin)!)
      })
    },
    async grant(scope, stillOwned) {
      if (!validScope(scope)) throw new Error('Invalid MDX consent scope')
      const { origin, root, remote, accountId } = scope
      const id = key(scope)
      const assertCurrent = () => {
        if (stillOwned && stillOwned() !== true) throw new Error('MDX consent owner changed')
        if (revocations.has(id)) throw new Error('MDX consent was revoked')
      }
      // Reject during admission and publication. If a revocation starts after admission,
      // the serialized write cannot clear its marker before this grant checks it.
      assertCurrent()
      return transact(async () => {
        assertCurrent()
        denied.add(id)
        const state = await read()
        if (!state.grants.some((grant) => key(grant) === id)) {
          state.grants.push({ origin, root, remote, accountId })
        }
        await persist(state, assertCurrent)
        // Revoke denies immediately, even if it arrives just after publication.
        if (!revocations.has(id)) denied.delete(id)
      })
    },
    async revoke(scope) {
      if (!validScope(scope)) throw new Error('Invalid MDX consent scope')
      const id = key(scope)
      const existing = revocations.get(id)
      if (existing?.write) return existing.write
      const revocation = { scope: { ...scope }, write: undefined as Promise<void> | undefined }
      revocations.set(id, revocation)
      denied.add(id)
      revocation.write = transact(async () => {
        try {
          const state = await read()
          state.grants = state.grants.filter((grant) => key(grant) !== id)
          await persist(state)
          revocations.delete(id)
        } finally {
          revocation.write = undefined
        }
      })
      return revocation.write
    },
    drain: () => queue,
  }
}
