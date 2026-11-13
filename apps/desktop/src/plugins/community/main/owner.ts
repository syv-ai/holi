import { join } from 'node:path'
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
      emit(remote: string, name: string, payload: unknown): void
      frameOrigin(origin: string): () => void
    },
  ): CommunityAttachment
  /** Serialize resource reads with machine mutations without notifying attachments. */
  admit<T>(work: () => Promise<T>): Promise<T>
  mutate<T>(work: () => Promise<T>): Promise<T>
}

const owners = new Map<string, CommunityOwner>()

export function communityOwner(args: { userData: string }): CommunityOwner {
  const existing = owners.get(args.userData)
  if (existing) return existing
  const attached = new Map<
    string,
    CommunityAttachment & {
      emit(remote: string, name: string, payload: unknown): void
      frameOrigin(origin: string): () => void
      notifyMutation(): Promise<void>
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
      let live = true
      let closing: Promise<void> | undefined
      const pending = new Set<Promise<unknown>>()
      let refreshTail: Promise<void> = Promise.resolve()
      let refreshQueued = false
      const attachment = {
        root,
        remote,
        signal: controller.signal,
        isLive: () => live,
        emit: (target: string, name: string, payload: unknown) => {
          if (live && target === remote) adapters.emit(remote, name, payload)
        },
        frameOrigin: adapters.frameOrigin,
        observer: undefined as ((signal: AbortSignal) => Promise<void>) | undefined,
        observeMutations(work: (signal: AbortSignal) => Promise<void>) {
          this.observer = work
        },
        run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
          if (!live) return Promise.reject(new Error('community attachment is closed'))
          const task = Promise.resolve().then(() => {
            if (!live) throw new Error('community attachment is closed')
            return work(controller.signal)
          })
          pending.add(task)
          void task.finally(() => pending.delete(task)).catch(() => {})
          return task
        },
        refresh(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
          if (!live) return Promise.resolve()
          if (refreshQueued) return refreshTail
          refreshQueued = true
          const task = refreshTail.then(() =>
            admit(async () => {
              refreshQueued = false
              if (live) await work(controller.signal)
            }),
          )
          refreshTail = task.catch(() => {})
          pending.add(task)
          void task.finally(() => pending.delete(task)).catch(() => {})
          return task
        },
        close(cleanup: () => Promise<void>): Promise<void> {
          if (closing) return closing
          live = false
          controller.abort()
          closing = (async () => {
            try {
              // Abort and stop synchronously-owned starts before draining tasks
              // that may be waiting for server readiness.
              await supervisor.stopAll((key) => key.startsWith(`${root}\0`))
              await Promise.allSettled([...pending])
              await cleanup()
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
    mutate<T>(work: () => Promise<T>): Promise<T> {
      const result = admit(work)
      const notify = async () => {
        await Promise.all(
          [...attached.values()].map((attachment) =>
            attachment.notifyMutation().catch((error) => {
              console.error('[community] refresh:', error)
            }),
          ),
        )
      }
      // Refresh only after the FIFO work releases its slot. Awaiting these
      // observers makes removal's cross-vault link cleanup part of completion.
      return result.then(
        async (value) => {
          await notify()
          return value
        },
        async (error: unknown) => {
          await notify()
          throw error
        },
      )
    },
  }
  owners.set(args.userData, owner)
  return owner
}
