import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hocuspocus } from '@hocuspocus/server'
import * as Y from 'yjs'
import { YDOC_TEXT_KEY } from '@holi/shared'
import { BaseStore } from '../src/main/vault/base-store'
import { DocBridge } from '../src/main/vault/doc-bridge'
import { connectDoc, SimClient, sleep, waitUntil } from './helpers/relay'

const PORT = 5611
const URL = `ws://127.0.0.1:${PORT}`

let relay: Hocuspocus
beforeAll(async () => {
  const { startRelay } = await import('./helpers/relay')
  relay = await startRelay(PORT)
})
afterAll(async () => {
  await relay.destroy()
})

interface Rig {
  bridge: DocBridge
  doc: Y.Doc
  filePath: string
  store: BaseStore
  turnStates: boolean[]
  destroy(): Promise<void>
}

async function rig(room: string, opts: { turnIdleMs?: number } = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-db-'))
  const filePath = join(dir, 'doc.md')
  const store = new BaseStore(join(dir, 'bases'))
  const doc = new Y.Doc()
  const conn = connectDoc(URL, room, doc)
  const turnStates: boolean[] = []
  const bridge = new DocBridge({
    doc,
    readFile: () => readFile(filePath, 'utf8').catch(() => null),
    writeFile: async (text) => void (await writeFile(filePath, text, 'utf8')),
    loadBase: () => store.load('d1'),
    saveBase: (b) => store.save('d1', b),
    onTurnState: (active) => turnStates.push(active),
    turnIdleMs: opts.turnIdleMs ?? 200,
    materializeDebounceMs: 40,
  })
  return {
    bridge,
    doc,
    filePath,
    store,
    turnStates,
    async destroy() {
      await bridge.stop()
      conn.destroy()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('DocBridge turn protocol', () => {
  it('(a) agent file edit merges; concurrent human edit to another region survives', async () => {
    const human = new SimClient(URL, 'db-a')
    human.text.insert(0, 'alpha\nomega\n')
    const r = await rig('db-a')
    await waitUntil(() => r.doc.getText(YDOC_TEXT_KEY).toString() === 'alpha\nomega\n')
    await r.bridge.start()
    expect(await readFile(r.filePath, 'utf8')).toBe('alpha\nomega\n')

    await writeFile(r.filePath, 'alpha\nomega (agent)\n', 'utf8')
    await r.bridge.onFileEvent()
    human.insertAfter('alpha', ' (human)') // buffers in the live CRDT mid-turn
    await waitUntil(() => !r.bridge.isTurnActive && r.bridge.turns === 1, 5000, 'turn done')
    await waitUntil(() => human.toString() === 'alpha (human)\nomega (agent)\n', 5000, 'human converged')
    expect(await readFile(r.filePath, 'utf8')).toBe('alpha (human)\nomega (agent)\n')
    expect(r.turnStates).toEqual([true, false])
    human.destroy()
    await r.destroy()
  })

  it('(c) the file stays frozen while a turn is open — remote edits do not hit disk mid-turn', async () => {
    const human = new SimClient(URL, 'db-c')
    human.text.insert(0, 'base\n')
    const r = await rig('db-c', { turnIdleMs: 400 })
    await waitUntil(() => r.doc.getText(YDOC_TEXT_KEY).toString() === 'base\n')
    await r.bridge.start()

    await writeFile(r.filePath, 'base\nagent line\n', 'utf8')
    await r.bridge.onFileEvent()
    expect(r.bridge.isTurnActive).toBe(true)
    human.text.insert(0, 'REMOTE ')
    await sleep(150) // < turnIdleMs: turn still open
    expect(await readFile(r.filePath, 'utf8')).toBe('base\nagent line\n') // frozen
    await waitUntil(() => !r.bridge.isTurnActive, 5000)
    const final = await readFile(r.filePath, 'utf8')
    expect(final).toContain('REMOTE')
    expect(final).toContain('agent line')
    human.destroy()
    await r.destroy()
  })

  it('(e) burst of writes coalesces into one turn; a later burst is a second turn', async () => {
    const r = await rig('db-e')
    r.doc.getText(YDOC_TEXT_KEY).insert(0, 'start\n')
    await r.bridge.start()
    await writeFile(r.filePath, 'start\none\n', 'utf8')
    await r.bridge.onFileEvent()
    await writeFile(r.filePath, 'start\none\ntwo\n', 'utf8')
    await r.bridge.onFileEvent()
    await waitUntil(() => !r.bridge.isTurnActive && r.bridge.turns === 1, 5000, 'first turn')
    await writeFile(r.filePath, 'start\none\ntwo\nthree\n', 'utf8')
    await r.bridge.onFileEvent()
    await waitUntil(() => r.bridge.turns === 2, 5000, 'second turn')
    expect(r.doc.getText(YDOC_TEXT_KEY).toString()).toBe('start\none\ntwo\nthree\n')
    await r.destroy()
  })

  it('signalTurnEnd() ends the turn immediately (the slice-2 Stop-hook seam)', async () => {
    const r = await rig('db-sig', { turnIdleMs: 60_000 }) // idle would never fire in-test
    r.doc.getText(YDOC_TEXT_KEY).insert(0, 'x\n')
    await r.bridge.start()
    await writeFile(r.filePath, 'x\ny\n', 'utf8')
    await r.bridge.onFileEvent()
    expect(r.bridge.isTurnActive).toBe(true)
    r.bridge.signalTurnEnd()
    await waitUntil(() => !r.bridge.isTurnActive, 5000)
    expect(r.doc.getText(YDOC_TEXT_KEY).toString()).toBe('x\ny\n')
    await r.destroy()
  })

  it('signalTurnOpen() engages the soft lock before the write lands (the PreToolUse seam)', async () => {
    const human = new SimClient(URL, 'db-open')
    human.text.insert(0, 'alpha\nomega\n')
    const r = await rig('db-open')
    await waitUntil(() => r.doc.getText(YDOC_TEXT_KEY).toString() === 'alpha\nomega\n')
    await r.bridge.start()

    r.bridge.signalTurnOpen() // hook fires BEFORE the agent's Write tool runs
    expect(r.bridge.isTurnActive).toBe(true)
    human.insertAfter('alpha', ' (human)') // human edit lands mid-turn
    await sleep(60)
    await writeFile(r.filePath, 'alpha\nomega (agent)\n', 'utf8')
    r.bridge.signalTurnEnd()

    await waitUntil(() => !r.bridge.isTurnActive && r.bridge.turns === 1, 5000, 'turn done')
    await waitUntil(() => human.toString() === 'alpha (human)\nomega (agent)\n', 5000, 'both survive')
    expect(await readFile(r.filePath, 'utf8')).toBe('alpha (human)\nomega (agent)\n')
    expect(r.turnStates).toEqual([true, false])
    human.destroy()
    await r.destroy()
  })

  it('signalTurnOpen() with no agent write releases as a clean no-op', async () => {
    const r = await rig('db-open-noop')
    r.doc.getText(YDOC_TEXT_KEY).insert(0, 'unchanged\n')
    await r.bridge.start()
    await waitUntil(async () => (await readFile(r.filePath, 'utf8')) === 'unchanged\n', 5000)
    const before = Y.encodeStateVector(r.doc)

    r.bridge.signalTurnOpen()
    expect(r.bridge.isTurnActive).toBe(true)
    r.bridge.signalTurnOpen() // idempotent while active
    await waitUntil(() => !r.bridge.isTurnActive, 5000, 'idle release')

    expect(r.doc.getText(YDOC_TEXT_KEY).toString()).toBe('unchanged\n')
    expect(Y.encodeStateVector(r.doc)).toEqual(before)
    expect(r.turnStates).toEqual([true, false])
    await r.destroy()
  })

  it('crash recovery: persisted base + diverged disk reconciles as a turn on start', async () => {
    const room = 'db-crash'
    const human = new SimClient(URL, room)
    human.text.insert(0, 'one\ntwo\n')
    const r1 = await rig(room)
    await waitUntil(() => r1.doc.getText(YDOC_TEXT_KEY).toString() === 'one\ntwo\n')
    await r1.bridge.start()
    const { filePath, store } = r1
    await r1.bridge.stop() // "crash": bridge gone, base persisted

    // agent wrote while we were down; a human also edited remotely
    await writeFile(filePath, 'one\ntwo\nagent-offline\n', 'utf8')
    human.text.insert(0, 'HUMAN ')

    const doc2 = new Y.Doc()
    const conn2 = connectDoc(URL, room, doc2)
    await waitUntil(() => doc2.getText(YDOC_TEXT_KEY).toString().startsWith('HUMAN '))
    const bridge2 = new DocBridge({
      doc: doc2,
      readFile: () => readFile(filePath, 'utf8').catch(() => null),
      writeFile: async (text) => void (await writeFile(filePath, text, 'utf8')),
      loadBase: () => store.load('d1'),
      saveBase: (b) => store.save('d1', b),
      onTurnState: () => {},
      turnIdleMs: 200,
    })
    await bridge2.start()
    await waitUntil(() => !bridge2.isTurnActive && bridge2.turns === 1, 5000, 'recovery turn')
    await waitUntil(() => human.toString() === 'HUMAN one\ntwo\nagent-offline\n', 5000, 'both survive')
    expect(await readFile(filePath, 'utf8')).toBe('HUMAN one\ntwo\nagent-offline\n')
    await bridge2.stop()
    conn2.destroy()
    human.destroy()
    await r1.destroy()
  })

  it('no persisted base: server truth wins over stray disk content', async () => {
    const r = await rig('db-nobase')
    r.doc.getText(YDOC_TEXT_KEY).insert(0, 'server truth\n')
    await writeFile(r.filePath, 'stray local content\n', 'utf8')
    await r.bridge.start()
    await waitUntil(async () => (await readFile(r.filePath, 'utf8')) === 'server truth\n', 5000)
    expect(r.bridge.turns).toBe(0)
    await r.destroy()
  })
})
