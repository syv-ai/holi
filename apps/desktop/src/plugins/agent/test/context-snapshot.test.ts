import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextSnapshot, CONTEXT_FILE } from '../main/host/context-snapshot'

const filesystemGate = vi.hoisted(() => ({
  target: null as string | null,
  enter: null as (() => void) | null,
  released: null as Promise<void> | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args)
      const path = String(args[0])
      if (
        filesystemGate.target !== null &&
        path.startsWith(`${filesystemGate.target}/.holi/state/.holi-tmp-`)
      ) {
        const enter = filesystemGate.enter
        const released = filesystemGate.released
        filesystemGate.target = null
        enter?.()
        await released
      }
    },
  }
})

const NOTE_PATH = 'notes/plan.md'
const OTHER_PATH = 'notes/other.md'

const dirs: string[] = []
const snapshots: ContextSnapshot[] = []
afterEach(async () => {
  await Promise.allSettled(snapshots.splice(0).map((snapshot) => snapshot.stop()))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

interface Rig {
  snapshot: ContextSnapshot
  root: string
  read(): Promise<any>
}

async function rig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'holi-ctx-'))
  dirs.push(root)
  await mkdir(join(root, '.holi/settings'), { recursive: true })
  const snapshot = new ContextSnapshot({ workRoot: root, debounceMs: 20 })
  snapshots.push(snapshot)
  return {
    snapshot,
    root,
    read: async () => JSON.parse(await readFile(join(root, CONTEXT_FILE), 'utf8')),
  }
}

describe('ContextSnapshot', () => {
  it('writes the focused note and open paths — nothing else', async () => {
    const r = await rig()
    r.snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH, OTHER_PATH] })
    await r.snapshot.flush()

    const ctx = await r.read()
    expect(ctx.focusedPath).toBe(NOTE_PATH)
    expect(ctx.openPaths).toEqual([NOTE_PATH, OTHER_PATH])
    expect(typeof ctx.updatedAt).toBe('string')
    // the agent finds tasks/backrefs itself — the writer carries no such fields
    expect(ctx).not.toHaveProperty('relatedTasks')
    expect(ctx).not.toHaveProperty('backrefPaths')
  })

  it('writes a null focus when nothing is focused', async () => {
    const r = await rig()
    r.snapshot.setFocus({ focusedPath: null, openPaths: [] })
    await r.snapshot.flush()

    const ctx = await r.read()
    expect(ctx.focusedPath).toBeNull()
    expect(ctx.openPaths).toEqual([])
  })

  it('never writes a secret file, focused or open', async () => {
    const r = await rig()
    r.snapshot.setFocus({
      focusedPath: 'apps/web/.env.production',
      selection: { startLine: 1, endLine: 2 },
      openPaths: [NOTE_PATH, '.secrets/key.md', 'notes/.envelope.md'],
    })
    await r.snapshot.flush()

    const ctx = await r.read()
    expect(ctx.focusedPath).toBeNull()
    expect(ctx.selection).toBeNull()
    expect(ctx.openPaths).toEqual([NOTE_PATH, 'notes/.envelope.md'])
  })

  it('coalesces a burst of focus changes — last wins', async () => {
    const r = await rig()
    r.snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH] })
    r.snapshot.setFocus({ focusedPath: OTHER_PATH, openPaths: [OTHER_PATH] })
    r.snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH, OTHER_PATH] })
    await r.snapshot.flush()

    const ctx = await r.read()
    expect(ctx.focusedPath).toBe(NOTE_PATH)
    expect(ctx.openPaths).toEqual([NOTE_PATH, OTHER_PATH])
  })

  it('rewrites the file when focus moves to another note', async () => {
    const r = await rig()
    r.snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH] })
    await r.snapshot.flush()
    expect((await r.read()).focusedPath).toBe(NOTE_PATH)

    r.snapshot.setFocus({ focusedPath: OTHER_PATH, openPaths: [OTHER_PATH] })
    await r.snapshot.flush()
    expect((await r.read()).focusedPath).toBe(OTHER_PATH)
  })

  it('cancels an unstarted debounce and makes stop idempotent', async () => {
    const r = await rig()
    r.snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH] })
    const stopping = r.snapshot.stop()
    r.snapshot.setFocus({ focusedPath: OTHER_PATH, openPaths: [OTHER_PATH] })
    await stopping
    await expect(readFile(join(r.root, CONTEXT_FILE), 'utf8')).rejects.toThrow()
    await expect(r.snapshot.stop()).resolves.toBeUndefined()
  })

  it('drains a temporary write revoked before its rename check', async () => {
    const r = await rig()
    r.snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH] })
    await r.snapshot.flush()

    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    filesystemGate.target = r.root
    filesystemGate.enter = enter
    filesystemGate.released = released

    r.snapshot.setFocus({ focusedPath: OTHER_PATH, openPaths: [OTHER_PATH] })
    const flushing = r.snapshot.flush()
    await entered

    let stopped = false
    const stopping = r.snapshot.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    release()
    await expect(flushing).resolves.toBeUndefined()
    await expect(stopping).resolves.toBeUndefined()
    await expect(r.snapshot.stop()).resolves.toBeUndefined()
    expect((await r.read()).focusedPath).toBe(NOTE_PATH)
    expect(await readdir(join(r.root, '.holi/state'))).toEqual(['context.local.json'])
  })

  it('retains a failed admitted write across repeated stop calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-ctx-failure-'))
    dirs.push(root)
    const blocker = join(root, 'not-a-directory')
    await writeFile(blocker, 'file')
    const snapshot = new ContextSnapshot({ workRoot: join(blocker, 'child'), debounceMs: 1 })
    snapshots.push(snapshot)
    snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const first = snapshot.stop().catch((error: unknown) => error)
    const failure = await first
    expect(failure).toBeInstanceOf(AggregateError)
    await expect(snapshot.stop()).rejects.toBe(failure)
  })

  it('stop() prevents further writes', async () => {
    const r = await rig()
    await r.snapshot.stop()
    r.snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH] })
    await r.snapshot.flush()
    await expect(readFile(join(r.root, CONTEXT_FILE), 'utf8')).rejects.toThrow()
  })
})
