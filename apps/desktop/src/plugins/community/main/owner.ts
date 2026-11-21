import { join } from 'node:path'
import { CapabilityError, UnconfirmedOwnedProgramError } from '../../../main/plugin-api'
import { createConsentStore } from './consent'
import { createSupervisor, type ServerState, type Supervisor } from './supervisor'
import { createInstallStore, type InstallStore } from './store'

interface CommunityAttachment {
  readonly signal: AbortSignal
  readonly root: string
  readonly remote: string
  /** Admit and drain work as part of this attachment's lifetime. */
  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>
  /** Coalesce refresh requests into one serialized refresh chain. */
  refresh(work: (signal: AbortSignal) => Promise<void>): Promise<void>
  observeMutations(work: (signal: AbortSignal) => Promise<void>): void
  /** Stop admission synchronously, abort and drain work, then clean up. */
  close(cleanup: () => Promise<void>): Promise<void>
  isLive(): boolean
}

/** Machine-owned community-plugin state shared by every open vault. */
export interface CommunityOwner {
  store: InstallStore
  consent: ReturnType<typeof createConsentStore>
  supervisor: Supervisor
  attach(
    root: string,
    remote: string,
    adapters: {
      activationSignal?: AbortSignal
      emit(remote: string, name: string, payload: unknown): void
      frameOrigin(origin: string): () => void
      forgetCheck?(id: string): Promise<void>
    },
  ): CommunityAttachment
  forgetChecks(id: string): Promise<void>
  notifyMutation(): Promise<void>
  /** Serialize resource reads with machine mutations without notifying attachments. */
  admit<T>(work: () => Promise<T>): Promise<T>
  mutate<T>(work: () => Promise<T>): Promise<T>
}

const owners = new Map<string, CommunityOwner>()

// Setup/check failures belong to the machine install, not to whichever Vault
// ran the command. Call under the owner's admission queue, before mutating the
// install or launching another command against it.
const uncertainInstalls = new WeakMap<InstallStore, Map<string, UnconfirmedOwnedProgramError>>()
const uncertainSetups = new WeakMap<AbortSignal, UnconfirmedOwnedProgramError>()

export function installProgramFailure(store: InstallStore, id: string) {
  return uncertainInstalls.get(store)?.get(id)
}

export function assertInstallProgramDrained(store: InstallStore, id: string): void {
  const failure = installProgramFailure(store, id)
  if (failure) throw failure
}

const installReservations = new WeakMap<InstallStore, Map<string, object>>()

export function installIsReserved(store: InstallStore, id: string): boolean {
  return installReservations.get(store)?.has(id) === true
}

export function assertInstallAvailable(store: InstallStore, id: string): void {
  if (installIsReserved(store, id))
    throw new CapabilityError('CONFLICT', `${id} installation is changing`)
}

/** Under admission, preserve the original cleanup failure ahead of a transient conflict. */
export function assertInstallLaunchable(store: InstallStore, id: string): void {
  assertInstallProgramDrained(store, id)
  assertInstallAvailable(store, id)
}

/** Under admission, claim a machine install until its drain and commit finish. */
export function reserveInstall(store: InstallStore, id: string) {
  assertInstallAvailable(store, id)
  let reservations = installReservations.get(store)
  if (!reservations) installReservations.set(store, (reservations = new Map()))
  const token = {}
  reservations.set(id, token)
  const current = () => reservations.get(id) === token
  return {
    assertCurrent() {
      if (!current()) throw new CapabilityError('CONFLICT', `${id} install reservation changed`)
    },
    release() {
      if (current()) reservations.delete(id)
    },
  }
}

export function retainInstallProgramFailure(
  store: InstallStore,
  id: string,
  error: unknown,
  setupSignal?: AbortSignal,
): void {
  if (!(error instanceof UnconfirmedOwnedProgramError)) return
  let failures = uncertainInstalls.get(store)
  if (!failures) uncertainInstalls.set(store, (failures = new Map()))
  if (!failures.has(id)) failures.set(id, error)
  if (setupSignal && !uncertainSetups.has(setupSignal)) uncertainSetups.set(setupSignal, error)
}

export function communityOwner(args: { userData: string }): CommunityOwner {
  const existing = owners.get(args.userData)
  if (existing) return existing
  const attached = new Map<
    string,
    CommunityAttachment & {
      emit(remote: string, name: string, payload: unknown): void
      frameOrigin(origin: string): () => void
      notifyMutation(): Promise<void>
      forgetCheck?(id: string): Promise<void>
      observer?: (signal: AbortSignal) => Promise<void>
    }
  >()
  let queue: Promise<unknown> = Promise.resolve()
  const admit = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work)
    queue = result.catch(() => undefined)
    return result
  }
  let owner: CommunityOwner
  const supervisor = createSupervisor({
    onState(key, state: ServerState) {
      const root = key.split('\0', 1)[0]!
      const attachment = attached.get(root)
      if (attachment?.isLive()) {
        const [, id, path] = key.split('\0')
        attachment.emit(attachment.remote, 'server', { id, path, state })
      }
    },
    frameOrigin(origin, key) {
      const root = key?.split('\0', 1)[0]
      const attachment = root === undefined ? undefined : attached.get(root)
      return attachment?.isLive() ? attachment.frameOrigin(origin) : () => {}
    },
  })
  owner = {
    store: createInstallStore(args.userData),
    consent: createConsentStore(join(args.userData, 'plugin-consent.json')),
    supervisor,
    attach(root, remote, adapters) {
      if (attached.has(root)) throw new Error(`community attachment already active: ${root}`)
      const controller = new AbortController()
      // The host can revoke ordinary work while its disposer is still queued.
      const signal = adapters.activationSignal
        ? AbortSignal.any([adapters.activationSignal, controller.signal])
        : controller.signal
      const isLive = () => !signal.aborted
      let closing: Promise<void> | undefined
      const pending = new Set<Promise<unknown>>()
      const track = <T>(task: Promise<T>): Promise<T> => {
        pending.add(task)
        void task.finally(() => pending.delete(task)).catch(() => {})
        return task
      }
      let refreshTail: Promise<void> = Promise.resolve()
      let refreshQueued = false
      const attachment = {
        root,
        remote,
        signal,
        isLive,
        emit: (target: string, name: string, payload: unknown) => {
          if (isLive() && target === remote) adapters.emit(remote, name, payload)
        },
        frameOrigin: adapters.frameOrigin,
        forgetCheck: adapters.forgetCheck,
        observer: undefined as ((signal: AbortSignal) => Promise<void>) | undefined,
        observeMutations(work: (signal: AbortSignal) => Promise<void>) {
          this.observer = work
        },
        run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
          if (!isLive()) return Promise.reject(new Error('community attachment is closed'))
          const task = Promise.resolve().then(() => {
            if (!isLive()) throw new Error('community attachment is closed')
            return work(signal)
          })
          return track(task)
        },
        refresh(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
          if (!isLive()) return Promise.resolve()
          if (refreshQueued) return refreshTail
          refreshQueued = true
          const task = refreshTail.then(async () => {
            refreshQueued = false
            if (isLive()) await work(signal)
          })
          refreshTail = task.catch(() => {})
          return track(task)
        },
        close(cleanup: () => Promise<void>): Promise<void> {
          if (closing) return closing
          controller.abort()
          closing = (async () => {
            try {
              // Abort and stop synchronously-owned starts before draining tasks
              // that may be waiting for server readiness.
              const servers = supervisor.stopAll((key) => key.startsWith(`${root}\0`))
              const [drain] = await Promise.allSettled([servers, ...pending])
              // A failed server proof cannot skip the attachment's check cleanup.
              const [cleaned] = await Promise.allSettled([Promise.resolve().then(cleanup)])
              if (drain?.status === 'rejected') throw drain.reason
              const setupFailure = uncertainSetups.get(signal)
              if (setupFailure) throw setupFailure
              if (cleaned?.status === 'rejected') throw cleaned.reason
            } finally {
              if (attached.get(root) === attachment) attached.delete(root)
            }
          })()
          return closing
        },
      } as CommunityAttachment & {
        emit(remote: string, name: string, payload: unknown): void
        frameOrigin(origin: string): () => void
        observer?: (signal: AbortSignal) => Promise<void>
        forgetCheck?(id: string): Promise<void>
        notifyMutation(): Promise<void>
      }
      attachment.notifyMutation = () =>
        attachment.refresh(async (signal) => {
          if (!signal.aborted) await attachment.observer?.(signal)
        })
      attached.set(root, attachment)
      return attachment
    },
    admit,
    async forgetChecks(id) {
      const results = await Promise.allSettled(
        [...attached.values()].map((attachment) => attachment.forgetCheck?.(id)),
      )
      for (const result of results) if (result.status === 'rejected') throw result.reason
    },
    async notifyMutation() {
      await Promise.all(
        [...attached.values()].map((attachment) =>
          attachment.notifyMutation().catch((error) => {
            console.error('[community] refresh:', error)
          }),
        ),
      )
    },
    async mutate<T>(work: () => Promise<T>): Promise<T> {
      try {
        return await admit(work)
      } finally {
        // Refresh after releasing the FIFO. Its checks may need native joins.
        await owner.notifyMutation()
      }
    },
  }
  owners.set(args.userData, owner)
  return owner
}
