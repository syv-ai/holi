import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, renameSync } from 'node:fs'
import { lstat, open, readFile, rm, type FileHandle } from 'node:fs/promises'
import { dirname, posix, win32 } from 'node:path'
import { promisify, TextDecoder } from 'node:util'
import { isRemote, MDX_RESOURCE_PURPOSE } from '@holi/shared'
import { isMdxExternalOrigin } from './mdx-external-policy'
import { canonicalGitHubRemote } from './mdx-trust'

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
  /** If storage could not be read, return only captured removals and mark the list incomplete. */
  listGrants(
    owner: Omit<MdxConsentScope, 'origin'>,
  ): Promise<{ grants: Grant[]; complete: boolean }>
  /** Pass a synchronous lifetime check for a document-bound approval. A retired approval rejects. */
  grant(scope: MdxConsentScope, stillOwned?: () => boolean): Promise<void>
  revoke(scope: MdxConsentScope): Promise<void>
  /** Synchronously observe an owned approval after durable publication, before queued reads.
   * Listeners must not throw. Returns an unsubscribe. */
  onSavedApproval(listener: (scope: MdxConsentScope) => void): () => void
  /** Synchronously observe each saved removal, including retries during drain.
   * Listeners must not throw. Returns an unsubscribe. */
  onRevocationSaved(listener: (scope: Readonly<MdxConsentScope>) => void): () => void
  /** After closing admission, wait for accepted operations and retry captured removals.
   * Reject if any revocation remains unsaved. No current owner is needed to remove an old grant. */
  drain(): Promise<void>
}

type State = { version: 1; grants: MdxConsentScope[] }
type Revocation = { scope: MdxConsentScope; write?: Promise<void> }
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// libuv uses MOVEFILE_REPLACE_EXISTING alone; syncing a regular file on Windows
// does not confirm its new name, and Node cannot open and flush a directory there.
// Use the system's write-through move, with no copy/delete fallback. Pass the
// paths as data, never as PowerShell source.
async function replaceOnWindows(source: string, target: string) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  if (!win32.isAbsolute(systemRoot)) throw new Error('Cannot locate system PowerShell')
  const shell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Holi -Name ConsentMove -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", ExactSpelling = true,
    CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
public static extern bool MoveFileExW(string source, string target, uint flags);
'@
# MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
if (![Holi.ConsentMove]::MoveFileExW($env:HOLI_CONSENT_SOURCE, $env:HOLI_CONSENT_TARGET, 0x9)) {
  throw [System.ComponentModel.Win32Exception]::new([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
`
  await promisify(execFile)(
    shell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      cwd: win32.dirname(shell),
      windowsHide: true,
      env: {
        ...process.env,
        HOLI_CONSENT_SOURCE: win32.toNamespacedPath(source),
        HOLI_CONSENT_TARGET: win32.toNamespacedPath(target),
      },
    },
  )
}

function validScope(value: unknown): value is MdxConsentScope {
  if (!value || typeof value !== 'object') return false
  const { origin, root, remote, accountId } = value as Partial<MdxConsentScope>
  const windows = process.platform === 'win32'
  const path = windows ? win32 : posix
  if (
    !isMdxExternalOrigin(origin) ||
    typeof root !== 'string' ||
    typeof remote !== 'string' ||
    typeof accountId !== 'string' ||
    root.includes('\0') ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    !isRemote(remote) ||
    remote.endsWith('/.') ||
    !Number.isSafeInteger(Number(accountId)) ||
    Number(accountId) <= 0 ||
    String(Number(accountId)) !== accountId
  )
    return false
  // Check spelling only: historical clones may be gone or temporarily offline.
  // The caller verifies the current clone with realpath before using its scope.
  if (windows) {
    if (
      root
        .replace(/^[a-z]:/i, '')
        .split('\\')
        .some((part) => /[ .]$|[\x01-\x1f\x7f<>:"|?*]/.test(part))
    )
      return false
    // The drive or UNC server/share is the namespace, not a DOS filename.
    const relative = root.slice(win32.parse(root).root.length)
    if (
      relative
        .split('\\')
        .some((part) =>
          /^(?:CON(?:IN\$|OUT\$)?|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?: *\.|$)/i.test(part),
        )
    )
      return false
  }
  try {
    return canonicalGitHubRemote(remote) === remote
  } catch {
    return false
  }
}

/** Machine-local, fail-closed HTTPS grants. Main keeps one store instance per file. */
export function createMdxConsentStore(file: string): MdxConsentStore {
  let queue = Promise.resolve()
  const denied = new Set<string>()
  const revocations = new Map<string, Revocation>()
  const approvalListeners = new Set<(scope: MdxConsentScope) => void>()
  const removalListeners = new Set<(scope: Readonly<MdxConsentScope>) => void>()
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
    let raw: Buffer
    try {
      raw = await readFile(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: VERSION, grants: [] }
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(utf8.decode(raw))
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
  const persist = async (
    state: State,
    approval?: { previous?: State; check(): void; saved(): void; unconfirmed(): void },
  ) => {
    const temp = `${file}.${randomUUID()}.tmp`
    const previous = approval?.previous
    const rollback = previous && `${temp}.rollback`
    const opened: FileHandle[] = []
    const staged: string[] = []
    const stage = async (path: string, value: State) => {
      const handle = await open(path, 'wx', 0o600)
      opened.push(handle)
      staged.push(path)
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
      return handle
    }
    try {
      // The profile directory belongs to Electron and must already exist. A
      // flush here cannot make an unsynced new ancestor directory durable.
      const directory =
        process.platform === 'win32' ? undefined : await open(dirname(file), constants.O_DIRECTORY)
      if (directory) opened.push(directory)
      const candidate = await stage(temp, state)
      if (rollback && previous) await stage(rollback, previous)
      let mayHaveReplaced = false
      const replace = async (path: string) => {
        if (directory) {
          renameSync(path, file)
          mayHaveReplaced = true
          await directory.sync()
        } else {
          // A failed helper can leave the move's result unknown.
          mayHaveReplaced = true
          await replaceOnWindows(path, file)
        }
      }
      approval?.check()
      try {
        await replace(temp)
        approval?.check()
      } catch (error) {
        if (rollback && mayHaveReplaced) {
          // The same-volume Windows move cannot have installed a copy if its
          // original name is still present (e.g. PowerShell was unavailable).
          if (
            !directory &&
            (await lstat(temp).then(
              () => true,
              () => false,
            ))
          )
            throw error
          try {
            await replace(rollback)
          } catch (restoreError) {
            // Even if the directory cannot be committed, invalidate the failed
            // candidate itself so a reader cannot pick it up after a reopen.
            approval?.unconfirmed()
            try {
              await candidate.truncate(0)
              await candidate.sync()
            } catch (invalidateError) {
              throw new AggregateError(
                [error, restoreError, invalidateError],
                'MDX approval rollback failed',
              )
            }
          }
        }
        throw error
      }
      // Publish within the queue, synchronously with the final ownership check.
      approval?.saved()
    } finally {
      for (const handle of opened) await handle.close().catch(() => undefined)
      for (const path of staged) await rm(path, { force: true }).catch(() => undefined)
    }
  }
  const saveRevocation = (id: string, revocation: Revocation): Promise<void> => {
    if (revocation.write) return revocation.write
    revocation.write = transact(async () => {
      try {
        const state = await read()
        state.grants = state.grants.filter((grant) => key(grant) !== id)
        await persist(state)
        revocations.delete(id)
        for (const listener of removalListeners) listener(revocation.scope)
      } finally {
        revocation.write = undefined
      }
    })
    return revocation.write
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
        const state = await read().catch(() => null)
        const listed = new Map<string, Grant>()
        for (const scope of state?.grants ?? []) {
          if (matches(scope) && !denied.has(key(scope)))
            listed.set(scope.origin, { origin: scope.origin })
        }
        // Captured removals remain visible and retryable even when the file is unreadable.
        for (const { scope } of revocations.values()) {
          if (matches(scope))
            listed.set(scope.origin, { origin: scope.origin, revocationPending: true })
        }
        return {
          grants: [...listed.keys()].sort().map((origin) => listed.get(origin)!),
          complete: state !== null,
        }
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
        const approved = { origin, root, remote, accountId }
        const isNew = !state.grants.some((grant) => key(grant) === id)
        await persist(isNew ? { ...state, grants: [...state.grants, approved] } : state, {
          previous: isNew ? state : undefined,
          check: assertCurrent,
          saved() {
            denied.delete(id)
            for (const listener of approvalListeners) listener({ ...approved })
          },
          unconfirmed() {
            if (!revocations.has(id)) revocations.set(id, { scope: approved })
          },
        })
      })
    },
    async revoke(scope) {
      if (!validScope(scope)) throw new Error('Invalid MDX consent scope')
      const id = key(scope)
      const revocation = revocations.get(id) ?? { scope: { ...scope } }
      revocations.set(id, revocation)
      denied.add(id)
      return saveRevocation(id, revocation)
    },
    onSavedApproval(listener) {
      approvalListeners.add(listener)
      return () => approvalListeners.delete(listener)
    },
    onRevocationSaved(listener) {
      removalListeners.add(listener)
      return () => removalListeners.delete(listener)
    },
    async drain() {
      await queue
      // Only retry removals already admitted by main. Retiring a lease, signing out,
      // or removing a vault does not discard the captured removal or unblock its key.
      const results = await Promise.allSettled(
        [...revocations].map(([id, revocation]) => saveRevocation(id, revocation)),
      )
      if (revocations.size > 0) {
        throw new AggregateError(
          results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
          'MDX resource revocation could not be saved',
        )
      }
    },
  }
}

/** Shared by ordinary quit and Restart to update. Neither may proceed on a failed drain. */
export async function withMdxConsentQuit(options: {
  consent: Pick<MdxConsentStore, 'drain'>
  pauseAdmission(): void
  resumeAdmission(): void
  reportBlocked(error: unknown): Promise<void>
  proceed(): Promise<boolean>
}): Promise<boolean> {
  options.pauseAdmission()
  let accepted = false
  let blocked: { error: unknown } | undefined
  try {
    try {
      await options.consent.drain()
    } catch (error) {
      blocked = { error }
      return false
    }
    accepted = await options.proceed()
    return accepted
  } finally {
    if (!accepted) options.resumeAdmission()
    if (blocked) await options.reportBlocked(blocked.error)
  }
}
