import type { AgentSessions } from './sessions'

/** Owns admitted asynchronous work until it settles; drain callers recheck the
 * set because an admitted operation can admit nested work before resolving. */
export interface OwnedOperationTracker {
  admit<T>(operation: () => Promise<T>): Promise<T>
  readonly pending: ReadonlySet<Promise<unknown>>
}

export function createOwnedOperationTracker(canAdmit: () => boolean): OwnedOperationTracker {
  const operations = new Set<Promise<unknown>>()
  return {
    admit<T>(operation: () => Promise<T>): Promise<T> {
      if (!canAdmit()) return Promise.reject(new Error('Agent session activation is stopping.'))
      const work = operation()
      operations.add(work)
      void work.then(
        () => operations.delete(work),
        () => operations.delete(work),
      )
      return work
    },
    get pending() {
      return operations
    },
  }
}

/** Presents the session interface with explicit revocation semantics. Async
 * operations reject without calling their implementation after revocation;
 * synchronous reads and notifications keep their declared return contracts. */
export function admitAgentSessions(
  api: AgentSessions,
  tracker: OwnedOperationTracker,
  isRevoked: () => boolean,
): AgentSessions {
  const asyncCall = <T>(call: () => Promise<T>): Promise<T> => tracker.admit(call)

  return {
    ensure: (vault) => asyncCall(() => api.ensure(vault)),
    sessions: () => (isRevoked() ? [] : api.sessions()),
    past: () => (isRevoked() ? [] : api.past()),
    refresh: () => asyncCall(() => api.refresh()),
    open: (args) => asyncCall(() => api.open(args)),
    start: (args) => asyncCall(() => api.start(args)),
    launch: (args) => asyncCall(() => api.launch(args)),
    watched: (id) => !isRevoked() && api.watched(id),
    onTurnEnd: (listener) => api.onTurnEnd(listener),
    onSessions: (listener) => api.onSessions(listener),
    send: (args) => asyncCall(() => api.send(args)),
    stop: (id) => asyncCall(() => api.stop(id)),
    respawn: (id) => asyncCall(() => api.respawn(id)),
    duplicate: (id, geometry) => asyncCall(() => api.duplicate(id, geometry)),
    noteTurn: (remote, jobId, active, pending, pid) =>
      asyncCall(() => api.noteTurn(remote, jobId, active, pending, pid)),
    noteStatus: (remote, jobId, status) => {
      if (!isRevoked()) api.noteStatus(remote, jobId, status)
    },
    noteChannel: (remote, jobId, channel) => {
      if (!isRevoked()) api.noteChannel(remote, jobId, channel)
    },
    message: (id, text) => asyncCall(() => api.message(id, text)),
    setFocus: (focus) => {
      if (!isRevoked()) api.setFocus(focus)
    },
    bracket: (id, edge) => api.bracket(id, edge),
    leave: (opts) => api.leave(opts),
  }
}
