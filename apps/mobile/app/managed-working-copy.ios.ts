import {
  isInIgnoredDir,
  isLocalOnlyPath,
  isRemote,
  isSecretPath,
  vaultRelPath,
} from '@holi/shared/mobile-path-safety'
import { nativeWorkingCopy } from './native-working-copy.ios'
import { nativeFiles } from './native-files.ios'
import { recoverMoves } from './storage-move'
import { validateStoragePath } from './operation-gate'
import {
  createManagedWorkingCopy,
  type ManagedWorkingCopyIdentity,
  type ManagedWorkingCopyNative,
  type WorkingCopyRefusal,
} from './working-copy'

type Checkpoint = 'prepared' | 'fetched' | 'authorized' | 'before-publication' | 'after-publication'
type Options = {
  endpoint?: string
  username?: string
  runId?: string
  onCheckpoint?: (
    phase: Checkpoint,
    paths: { stage: string; container: string; target: string },
  ) => Promise<void>
}

class TransportFailure extends Error {
  readonly refusal: WorkingCopyRefusal
  constructor(code: string, message: string) {
    super(message)
    this.refusal = { code, message }
  }
}

function checked<T>(operation: (error: interop.Reference<NSError>) => T | null): T {
  const error = new interop.Reference<NSError>()
  const result = operation(error)
  if (error.value) {
    const number = Number(error.value.code)
    const code =
      number === 2 || number === -3
        ? 'missing'
        : number === -16
          ? 'authentication'
          : number === -17
            ? 'certificate'
            : number === -11
              ? 'non-fast-forward'
              : number === -15
                ? 'stale'
                : number === -7 || number === 27
                  ? 'resource-limit'
                  : number === 17 || number === -4
                    ? 'collision'
                    : number === 22 || number === 1 || number === -12
                      ? 'rejected'
                      : 'transport'
    throw new TransportFailure(code, String(error.value.localizedDescription))
  }
  if (result === null || result === undefined)
    throw new TransportFailure('transport', 'Native operation returned no result')
  return result
}

function identity(value: NSDictionary<string, NSObject>): ManagedWorkingCopyIdentity {
  return {
    remote: String(value.objectForKey('remote')),
    branch: String(value.objectForKey('branch')),
    nativeId: String(value.objectForKey('nativeId')),
  }
}

function authorize(plan: NSDictionary<string, NSObject>, checkout = false): void {
  const names = new Map<string, { raw: string; directory: boolean }>()
  const entries = plan.objectForKey('entries') as NSArray<NSDictionary<string, NSObject>>
  if (!entries || typeof entries.count !== 'number')
    throw new TransportFailure('rejected', 'Invalid native tree plan')
  for (let index = 0; index < entries.count; index++) {
    const entry = entries.objectAtIndex(index)
    const raw = String(entry.objectForKey('path'))
    const path = vaultRelPath(raw)
    if (checkout) {
      const parts = path.split('/')
      for (let part = 0; part < parts.length; part++) {
        const prefix = parts.slice(0, part + 1).join('/')
        const key = prefix.normalize('NFD').toLowerCase()
        const directory = part < parts.length - 1
        const previous = names.get(key)
        if (previous && (previous.raw !== prefix || previous.directory !== directory))
          throw new TransportFailure('collision', 'Git tree contains filesystem aliases')
        names.set(key, { raw: prefix, directory })
      }
    }
    if (
      path !== raw ||
      String(entry.objectForKey('kind')) !== 'file' ||
      isInIgnoredDir(path) ||
      isInIgnoredDir(path.toLowerCase()) ||
      isSecretPath(path) ||
      isLocalOnlyPath(path)
    )
      throw new TransportFailure(
        'protected-content',
        'Git tree contains unsupported or machine-local content',
      )
  }
}

/** Composes the portable working-copy interface with the embedded iOS implementation. */
export function createManagedWorkingCopyIOS(
  target: { remote: string; root: string; branch: string },
  credential: string,
  options: Options = {},
) {
  const { remote, root, branch } = target
  if (!isRemote(remote)) throw new TransportFailure('rejected', 'Invalid vault identity')
  const separator = remote.indexOf('/')
  const owner = remote.slice(0, separator)
  const repository = remote.slice(separator + 1)
  const endpoint = options.endpoint ?? `https://github.com/${remote}.git`
  const username = options.username ?? 'x-access-token'
  const runId = options.runId ?? NSUUID.UUID().UUIDString
  const onCheckpoint = options.onCheckpoint
  const client = checked((error) =>
    HoliNativeGit.alloc().initWithOwnerRepositoryNameEndpointError(
      owner,
      repository,
      endpoint,
      error,
    ),
  )
  const acquisition = HoliManagedAcquisition.alloc().init()
  const records = HoliManagedIdentity.alloc().init()
  const exists = (path: string) => {
    try {
      checked((error) => client.canonicalRootError(path, error))
      return true
    } catch (error) {
      if (error instanceof TransportFailure && error.refusal.code === 'missing') return false
      throw error
    }
  }
  const reopen = (path: string): ManagedWorkingCopyIdentity => {
    const binding = identity(checked((error) => client.managedIdentityError(path, error)))
    const retained = receipts(path)
      .filter((receipt) => {
        const record = receipt.objectForKey('receipt') as NSDictionary<string, NSObject>
        return (
          String(record.objectForKey('nativeId')) !== binding.nativeId &&
          String(record.objectForKey('phase')) !== 'after-publication'
        )
      })
      .map((receipt) => String(receipt.objectForKey('containerPath')))
    return retained.length ? { ...binding, retainedAcquisitions: retained } : binding
  }
  const receipts = (path: string) => {
    const result = checked((error) => acquisition.receiptsAtTargetError(path, error))
    const list = result.objectForKey('receipts') as NSArray<NSDictionary<string, NSObject>>
    const failures = result.objectForKey('refusals') as NSArray<NSObject>
    if (failures.count)
      throw new TransportFailure('recovery-needed', 'An acquisition ownership record is invalid')
    const found: NSDictionary<string, NSObject>[] = []
    for (let i = 0; i < list.count; i++) found.push(list.objectAtIndex(i))
    return found
  }
  const checkpoint = async (phase: Checkpoint, receipt: NSDictionary<string, NSObject>) => {
    if (onCheckpoint)
      await onCheckpoint(phase, {
        stage: String(receipt.objectForKey('stagePath')),
        container: String(receipt.objectForKey('containerPath')),
        target: String(receipt.objectForKey('targetPath')),
      })
  }
  const run = (operation: 'clone' | 'fetch', path: string, selected: string, token: string) =>
    checked((error) =>
      client.runSelectedBranchOperationRootRemoteOwnerRepositoryNameBranchUsernamePasswordError(
        operation,
        path,
        endpoint,
        owner,
        repository,
        selected,
        username,
        token,
        error,
      ),
    )
  const native: ManagedWorkingCopyNative = {
    ...nativeWorkingCopy,
    async canonicalRoot(path) {
      return String(checked((error) => acquisition.rootKeyAtTargetError(path, error)))
    },
    async recover(path, expected) {
      if (!exists(path)) {
        if (expected.nativeId) throw new TransportFailure('stale', 'Managed checkout disappeared')
        return
      }
      // Read only the binding before recovery; do not let a stale handle recover
      // a replacement checkout, and do not access Git before storage recovery.
      const binding = identity(checked((error) => records.readIdentityAtRootError(path, error)))
      if (
        binding.remote !== expected.remote ||
        binding.branch !== expected.branch ||
        (expected.nativeId !== undefined && binding.nativeId !== expected.nativeId)
      )
        throw new TransportFailure('stale', 'Managed checkout identity changed')
      await recoverMoves(nativeFiles, path, validateStoragePath)
      for (const receipt of receipts(path)) {
        const record = receipt.objectForKey('receipt') as NSDictionary<string, NSObject>
        if (
          String(record.objectForKey('nativeId')) === binding.nativeId &&
          String(record.objectForKey('phase')) !== 'after-publication'
        )
          checked((error) => acquisition.finishReceiptError(receipt, error))
      }
    },
    async identity(path) {
      const binding = reopen(path)
      return { remotes: [binding.remote], branch: binding.branch, attached: true }
    },
    async prepare(path, requestedRemote, selected, token) {
      if (requestedRemote !== remote)
        throw new TransportFailure('rejected', 'Acquisition remote mismatch')
      const previous = receipts(path)
      for (const receipt of previous) {
        const record = receipt.objectForKey('receipt') as NSDictionary<string, NSObject>
        if (
          String(record.objectForKey('remote')) !== remote ||
          String(record.objectForKey('branch')) !== selected
        )
          throw new TransportFailure(
            'recovery-needed',
            'Interrupted acquisition belongs to another selection',
          )
      }
      if (exists(path)) {
        const binding = reopen(path)
        for (const receipt of previous) {
          const record = receipt.objectForKey('receipt') as NSDictionary<string, NSObject>
          if (String(record.objectForKey('nativeId')) === binding.nativeId)
            checked((error) => acquisition.finishReceiptError(receipt, error))
        }
        return binding
      }
      // Resume a complete metadata stage; incomplete network stages remain intact.
      let receipt = previous.find((item) => {
        const stage = String(item.objectForKey('stagePath'))
        try {
          const binding = reopen(stage)
          return binding.remote === remote && binding.branch === selected
        } catch (error) {
          if (error instanceof TransportFailure) return false
          throw error
        }
      })
      if (!receipt) {
        receipt = checked((error) =>
          acquisition.beginAtTargetRemoteBranchRunIdError(path, remote, selected, runId, error),
        )
        await checkpoint('prepared', receipt)
        run('clone', String(receipt.objectForKey('stagePath')), selected, token)
      }
      const stage = String(receipt.objectForKey('stagePath'))
      await checkpoint('fetched', receipt)
      const incoming = checked((error) => client.committedEntriesHistoryError(stage, false, error))
      authorize(incoming, true)
      if (!checked((error) => client.materializeManagedPlanError(stage, incoming, error)))
        throw new TransportFailure('rejected', 'Checkout materialization refused')
      await checkpoint('authorized', receipt)
      if (onCheckpoint) {
        if (
          !checked((error) =>
            acquisition.checkpointReceiptNameError(receipt, 'before-publication', error),
          )
        )
          throw new TransportFailure('rejected', 'Acquisition checkpoint refused')
        await checkpoint('before-publication', receipt)
      }
      checked((error) => acquisition.finishReceiptError(receipt, error))
      await checkpoint('after-publication', receipt)
      return reopen(path)
    },
    async reopen(path) {
      return reopen(path)
    },
    async fetch(path, binding, token) {
      if (binding.remote !== remote) throw new TransportFailure('rejected', 'Fetch remote mismatch')
      run('fetch', path, binding.branch, token)
    },
    async publish(path, binding, token) {
      if (binding.remote !== remote)
        throw new TransportFailure('rejected', 'Publication remote mismatch')
      const plan = checked((error) => client.committedEntriesHistoryError(path, true, error))
      authorize(plan)
      checked((error) =>
        client.publishManagedPlanUsernamePasswordError(path, plan, username, token, error),
      )
    },
  }
  return createManagedWorkingCopy(native, { remote, root, branch }, credential)
}
