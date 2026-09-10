import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextSnapshot, CONTEXT_FILE } from '../src/main/agent/context-snapshot'

const NOTE_PATH = 'notes/plan.md'
const OTHER_PATH = 'notes/other.md'

const dirs: string[] = []
const snapshots: ContextSnapshot[] = []
afterEach(async () => {
  for (const s of snapshots.splice(0)) s.stop()
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
  it('writes the focused note and open paths — nothing else (D60)', async () => {
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

  it('stop() prevents further writes', async () => {
    const r = await rig()
    r.snapshot.stop()
    r.snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH] })
    await r.snapshot.flush()
    await expect(readFile(join(r.root, CONTEXT_FILE), 'utf8')).rejects.toThrow()
  })
})
