import { describe, expect, it } from 'vitest'
import { createFrameContextMetadata } from '../src/plugins/browser/main/frame-context-metadata'

const defaultContext = (id: number, uniqueId: string, generation: number, sessionId?: string) => ({
  frameId: 'frame',
  contextId: id,
  uniqueId,
  generation,
  sessionId,
  isDefault: true,
})

describe('private frame context registry', () => {
  it('owns worlds and contexts through document replacement and frame departure', async () => {
    const registry = createFrameContextMetadata()
    const generation = registry.nextGeneration(undefined, 'frame', 'document-a')
    const context = defaultContext(1, 'document-a', generation)
    registry.ingest(context)
    const first = registry.getOrCreateWorld(context, 'frame', async () => ({
      contextId: 2,
      uniqueId: 'world-a',
    }))
    await expect(first).resolves.toEqual({ contextId: 2, uniqueId: 'world-a' })
    registry.ingest({ ...context, contextId: 2, uniqueId: 'world-a', isDefault: false })
    expect(registry.metadataCounts()).toEqual({
      contexts: 2,
      live: 2,
      frames: 1,
      worlds: 1,
      pending: 0,
    })

    const replacement = registry.nextGeneration(undefined, 'frame', 'document-b')
    registry.ingest(defaultContext(3, 'document-b', replacement))
    expect(registry.metadataCounts()).toEqual({
      contexts: 1,
      live: 1,
      frames: 1,
      worlds: 0,
      pending: 0,
    })
    registry.dropFrame(undefined, 'frame')
    expect(registry.metadataCounts()).toEqual({
      contexts: 0,
      live: 0,
      frames: 0,
      worlds: 0,
      pending: 0,
    })
    expect(registry.lookup(undefined, 1)).toBeUndefined()
    expect(registry.isLive(undefined, 3)).toBe(false)
  })

  it('prunes same-process frame and detached-session ownership and makes fresh worlds', async () => {
    const registry = createFrameContextMetadata()
    let prior = 0
    for (let index = 0; index < 100; index++) {
      const generation = registry.nextGeneration('session', 'reused-frame', `document-${index}`)
      expect(generation).toBeGreaterThan(prior)
      prior = generation
      const context = {
        ...defaultContext(index * 2, `document-${index}`, generation, 'session'),
        frameId: 'reused-frame',
      }
      registry.ingest(context)
      const world = await registry.getOrCreateWorld(context, 'frame', async () => ({
        contextId: index * 2 + 1,
        uniqueId: `world-${index}`,
      }))
      registry.ingest({
        ...context,
        contextId: world.contextId,
        uniqueId: world.uniqueId,
        isDefault: false,
      })
      expect(registry.metadataCounts().worlds).toBe(1)
      registry.dropFrame('session', 'reused-frame')
      expect(registry.metadataCounts()).toEqual({
        contexts: 0,
        live: 0,
        frames: 0,
        worlds: 0,
        pending: 0,
      })
    }
    const generation = registry.nextGeneration('session', 'reused-frame', 'fresh')
    const fresh = {
      ...defaultContext(500, 'fresh', generation, 'session'),
      frameId: 'reused-frame',
    }
    registry.ingest(fresh)
    await expect(
      registry.getOrCreateWorld(fresh, 'frame', async () => ({
        contextId: 501,
        uniqueId: 'fresh-world',
      })),
    ).resolves.toEqual({ contextId: 501, uniqueId: 'fresh-world' })
    registry.dropSession('session')
    expect(registry.metadataCounts()).toEqual({
      contexts: 0,
      live: 0,
      frames: 0,
      worlds: 0,
      pending: 0,
    })
  })

  it('bounds pending descriptors and prevents a late allocation from reviving a dropped owner', async () => {
    const registry = createFrameContextMetadata()
    registry.queuePending('session', 'frame', { contextId: 9 })
    expect(registry.metadataCounts().pending).toBe(1)
    const generation = registry.nextGeneration('session', 'frame', 'document')
    expect(registry.takePending('session', 'frame')).toEqual([{ contextId: 9 }])
    const context = defaultContext(1, 'document', generation, 'session')
    registry.ingest(context)
    let release!: (world: { contextId: number; uniqueId: string }) => void
    const pending = registry.getOrCreateWorld(
      context,
      'frame',
      () => new Promise((resolve) => (release = resolve)),
    )
    registry.dropSession('session')
    release({ contextId: 2, uniqueId: 'late-world' })
    await expect(pending).rejects.toThrow('no longer current')
    expect(registry.metadataCounts()).toEqual({
      contexts: 0,
      live: 0,
      frames: 0,
      worlds: 0,
      pending: 0,
    })
  })

  it('removes destroyed pending descriptors before a default context arrives', async () => {
    const registry = createFrameContextMetadata()
    registry.queuePending('session-a', 'frame', { id: 9, uniqueId: 'world-a' })
    registry.queuePending('session-b', 'frame', { id: 9, uniqueId: 'world-b' })
    registry.removePendingContext('session-a', 9)
    const generation = registry.nextGeneration('session-a', 'frame', 'document')
    registry.ingest(defaultContext(1, 'document', generation, 'session-a'))
    expect(registry.takePending('session-a', 'frame')).toEqual([])
    expect(registry.metadataCounts().pending).toBe(1)
    expect(registry.takePending('session-b', 'frame')).toEqual([{ id: 9, uniqueId: 'world-b' }])
    expect(registry.isLive('session-a', 9)).toBe(false)
    expect(registry.metadataCounts().pending).toBe(0)
    expect(registry.metadataCounts().worlds).toBe(0)
    await expect(
      registry.getOrCreateWorld(registry.lookup('session-a', 1)!, 'frame', async () => ({
        contextId: 9,
        uniqueId: 'fresh-world',
      })),
    ).resolves.toEqual({ contextId: 9, uniqueId: 'fresh-world' })
    registry.ingest({
      ...defaultContext(9, 'fresh-world', generation, 'session-a'),
      isDefault: false,
    })
    expect(registry.isLive('session-a', 9)).toBe(true)
    expect(registry.metadataCounts()).toMatchObject({ worlds: 1, pending: 0 })
  })

  it('prunes the actual isolated-world cache when its context departs', async () => {
    const registry = createFrameContextMetadata()
    const generation = registry.nextGeneration(undefined, 'frame', 'document')
    const context = defaultContext(1, 'document', generation)
    registry.ingest(context)
    await registry.getOrCreateWorld(context, 'frame', async () => ({
      contextId: 2,
      uniqueId: 'world',
    }))
    registry.ingest({ ...context, contextId: 2, uniqueId: 'world', isDefault: false })
    registry.dropWorldsForContext(registry.lookup(undefined, 2)!)
    registry.removeContext(undefined, 2)
    expect(registry.metadataCounts()).toEqual({
      contexts: 1,
      live: 1,
      frames: 1,
      worlds: 0,
      pending: 0,
    })
    registry.queuePending(undefined, 'another-frame', { contextId: 99 })
    registry.clear()
    expect(registry.metadataCounts()).toEqual({
      contexts: 0,
      live: 0,
      frames: 0,
      worlds: 0,
      pending: 0,
    })
  })
})
