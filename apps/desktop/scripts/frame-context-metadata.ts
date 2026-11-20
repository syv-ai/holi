export type FrameContext = {
  frameId: string
  contextId: number
  uniqueId: string
  generation: number
  sessionId?: string
  isDefault: boolean
  name?: string
}

type World = { contextId: number; uniqueId: string }
type WorldEntry = {
  sessionId?: string
  frameId: string
  generation: number
  documentUniqueId: string
  purpose: string
  resolved?: World
  promise: Promise<World>
}
type PendingWorld = { sessionId?: string; frameId: string; descriptor: unknown }
const sessionKey = (sessionId?: string) => sessionId ?? ''
const contextKey = (sessionId: string | undefined, contextId: number) =>
  `${sessionKey(sessionId)}\0${contextId}`
const frameKey = (sessionId: string | undefined, frameId: string) =>
  `${sessionKey(sessionId)}\0${frameId}`

/** Owns the adapter-local context lifecycle and every cache derived from it. */
export function createFrameContextMetadata() {
  const contexts = new Map<string, FrameContext>()
  const liveContexts = new Map<string, Set<number>>()
  const generations = new Map<string, number>()
  const identities = new Map<string, string>()
  const worlds = new Map<string, WorldEntry>()
  const pendingWorlds = new Map<string, PendingWorld[]>()
  let nextGeneration = 0

  const removeWorlds = (matches: (world: WorldEntry) => boolean) => {
    for (const [key, world] of worlds) if (matches(world)) worlds.delete(key)
  }
  const removePendingContext = (sessionId: string | undefined, contextId: number) => {
    for (const [key, pending] of pendingWorlds) {
      if (key.startsWith(`${sessionKey(sessionId)}\0`)) {
        const remaining = pending.filter(
          ({ descriptor }) => (descriptor as { id?: unknown } | null)?.id !== contextId,
        )
        if (remaining.length) pendingWorlds.set(key, remaining)
        else pendingWorlds.delete(key)
      }
    }
  }
  const removeContext = (sessionId: string | undefined, contextId: number) => {
    const context = contexts.get(contextKey(sessionId, contextId))
    if (context) {
      removeWorlds(
        (world) =>
          sessionKey(world.sessionId) === sessionKey(sessionId) &&
          world.frameId === context.frameId &&
          world.generation === context.generation &&
          (world.resolved?.contextId === contextId ||
            world.resolved?.uniqueId === context.uniqueId),
      )
    }
    removePendingContext(sessionId, contextId)
    contexts.delete(contextKey(sessionId, contextId))
    liveContexts.get(sessionKey(sessionId))?.delete(contextId)
  }
  const clearFrame = (sessionId: string | undefined, frameId: string) => {
    const key = frameKey(sessionId, frameId)
    generations.delete(key)
    identities.delete(key)
    for (const context of contexts.values())
      if (sessionKey(context.sessionId) === sessionKey(sessionId) && context.frameId === frameId)
        removeContext(context.sessionId, context.contextId)
    removeWorlds(
      (world) => sessionKey(world.sessionId) === sessionKey(sessionId) && world.frameId === frameId,
    )
    pendingWorlds.delete(key)
  }

  return {
    lookup(sessionId: string | undefined, contextId: number) {
      return contexts.get(contextKey(sessionId, contextId))
    },
    isLive(sessionId: string | undefined, contextId: number) {
      return liveContexts.get(sessionKey(sessionId))?.has(contextId) ?? false
    },
    isCurrent(context: FrameContext) {
      const current = contexts.get(contextKey(context.sessionId, context.contextId))
      return (
        liveContexts.get(sessionKey(context.sessionId))?.has(context.contextId) === true &&
        current?.uniqueId === context.uniqueId &&
        current.generation === context.generation &&
        generations.get(frameKey(context.sessionId, context.frameId)) === context.generation
      )
    },
    ingest(context: FrameContext) {
      let live = liveContexts.get(sessionKey(context.sessionId))
      if (!live) liveContexts.set(sessionKey(context.sessionId), (live = new Set()))
      live.add(context.contextId)
      contexts.set(contextKey(context.sessionId, context.contextId), context)
    },
    removeContext,
    removePendingContext,
    contextsForSession(sessionId?: string) {
      return [...contexts.values()].filter(
        (context) => sessionKey(context.sessionId) === sessionKey(sessionId),
      )
    },
    findContext(predicate: (context: FrameContext) => boolean) {
      return [...contexts.values()].find(predicate)
    },

    nextGeneration(sessionId: string | undefined, frameId: string, uniqueId?: string) {
      const key = frameKey(sessionId, frameId)
      if (uniqueId && identities.get(key) === uniqueId) return generations.get(key)!
      const oldGeneration = generations.get(key)
      if (oldGeneration !== undefined) {
        for (const context of contexts.values())
          if (
            sessionKey(context.sessionId) === sessionKey(sessionId) &&
            context.frameId === frameId
          )
            removeContext(context.sessionId, context.contextId)
        removeWorlds(
          (world) =>
            sessionKey(world.sessionId) === sessionKey(sessionId) &&
            world.frameId === frameId &&
            world.generation === oldGeneration,
        )
        pendingWorlds.delete(key)
      }
      const generation = ++nextGeneration
      generations.set(key, generation)
      if (uniqueId) identities.set(key, uniqueId)
      else identities.delete(key)
      return generation
    },
    generation(sessionId: string | undefined, frameId: string) {
      return generations.get(frameKey(sessionId, frameId))
    },
    queuePending(sessionId: string | undefined, frameId: string, descriptor: unknown) {
      const key = frameKey(sessionId, frameId)
      pendingWorlds.set(key, [
        ...(pendingWorlds.get(key) ?? []),
        { sessionId, frameId, descriptor },
      ])
    },
    takePending(sessionId: string | undefined, frameId: string) {
      const key = frameKey(sessionId, frameId)
      const pending = pendingWorlds.get(key) ?? []
      pendingWorlds.delete(key)
      return pending.map(({ descriptor }) => descriptor)
    },
    getOrCreateWorld(
      context: FrameContext,
      purpose: string,
      create: () => Promise<World>,
    ): Promise<World> {
      if (!this.isCurrent(context)) throw new Error('frame document context is no longer current')
      const key = JSON.stringify([
        sessionKey(context.sessionId),
        context.frameId,
        context.generation,
        context.uniqueId,
        purpose,
      ])
      const existing = worlds.get(key)
      if (existing) return existing.promise
      const entry: WorldEntry = {
        sessionId: context.sessionId,
        frameId: context.frameId,
        generation: context.generation,
        documentUniqueId: context.uniqueId,
        purpose,
        promise: Promise.resolve({ contextId: -1, uniqueId: '' }),
      }
      const promise = create().then((world) => {
        if (worlds.get(key) !== entry || !this.isCurrent(context))
          throw new Error('isolated world owner is no longer current')
        entry.resolved = world
        entry.promise = Promise.resolve(world)
        return world
      })
      entry.promise = promise
      worlds.set(key, entry)
      void promise.catch(() => {
        if (worlds.get(key) === entry) worlds.delete(key)
      })
      return promise
    },
    dropWorldsForContext(context: FrameContext) {
      removeWorlds(
        (world) =>
          sessionKey(world.sessionId) === sessionKey(context.sessionId) &&
          world.frameId === context.frameId &&
          world.generation === context.generation &&
          (world.documentUniqueId === context.uniqueId ||
            world.resolved?.contextId === context.contextId ||
            world.resolved?.uniqueId === context.uniqueId),
      )
    },
    dropFrame: clearFrame,
    dropSession(sessionId: string | undefined) {
      const prefix = `${sessionKey(sessionId)}\0`
      for (const key of [...generations.keys()])
        if (key.startsWith(prefix)) {
          const frameId = key.slice(prefix.length)
          clearFrame(sessionId, frameId)
        }
      for (const context of [...contexts.values()])
        if (sessionKey(context.sessionId) === sessionKey(sessionId))
          removeContext(sessionId, context.contextId)
      liveContexts.delete(sessionKey(sessionId))
      for (const key of [...pendingWorlds.keys()])
        if (key.startsWith(prefix)) pendingWorlds.delete(key)
      removeWorlds((world) => sessionKey(world.sessionId) === sessionKey(sessionId))
    },
    clear() {
      contexts.clear()
      liveContexts.clear()
      generations.clear()
      identities.clear()
      worlds.clear()
      pendingWorlds.clear()
    },
    metadataCounts() {
      return {
        contexts: contexts.size,
        live: [...liveContexts.values()].reduce((sum, ids) => sum + ids.size, 0),
        frames: generations.size,
        worlds: worlds.size,
        pending: [...pendingWorlds.values()].reduce((sum, entries) => sum + entries.length, 0),
      }
    },
  }
}
