import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hocuspocus } from '@hocuspocus/server'
import { AgentSim } from '../src/agent'
import { BridgeClient } from '../src/bridge-client'
import { connectDoc, converged, SimClient, sleep, startRelay, waitUntil } from '../src/harness'

const PORT = 5401
const URL = `ws://127.0.0.1:${PORT}`

let relay: Hocuspocus
beforeAll(async () => {
  relay = await startRelay(PORT)
})
afterAll(async () => {
  await relay.destroy()
})

interface Scenario {
  filePath: string
  h1: SimClient
  h2: SimClient
  bridge: BridgeClient
  agent: AgentSim
  all: () => string[]
  settle: (expectedTurns: number) => Promise<string>
  teardown: () => Promise<void>
}

async function setupScenario(
  room: string,
  seed: string,
  bridgeOpts: ConstructorParameters<typeof BridgeClient>[1] = {},
): Promise<Scenario> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-spike-'))
  const filePath = join(dir, 'doc.md')
  const h1 = new SimClient(URL, room)
  const h2 = new SimClient(URL, room)
  h1.text.insert(0, seed)
  await waitUntil(() => h2.toString() === seed, 10_000, 'seed propagated to h2')

  const bridge = new BridgeClient(filePath, bridgeOpts)
  const conn = connectDoc(URL, room, bridge.doc)
  await waitUntil(() => bridge.text.toString() === seed, 10_000, 'bridge doc synced')
  await bridge.start()
  const agent = new AgentSim(filePath)

  const all = () => [h1.toString(), h2.toString(), bridge.text.toString()]
  return {
    filePath,
    h1,
    h2,
    bridge,
    agent,
    all,
    settle: async (expectedTurns: number) => {
      await waitUntil(() => bridge.turns >= expectedTurns, 15_000, `turns >= ${expectedTurns}`)
      await waitUntil(() => !bridge.isTurnActive, 15_000, 'turn released')
      await waitUntil(() => converged(all()), 10_000, 'replicas converged')
      await sleep(200) // let final re-materialization land on disk
      return readFile(filePath, 'utf8')
    },
    teardown: async () => {
      await bridge.stop()
      conn.destroy()
      h1.destroy()
      h2.destroy()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('bridge harness smoke', () => {
  it('materializes the doc and reflects a pure human edit back to disk', async () => {
    const s = await setupScenario('smoke', 'hello\n')
    try {
      await waitUntil(async () => (await readFile(s.filePath, 'utf8')) === 'hello\n')
      s.h1.insertAfter('hello', ' world')
      await waitUntil(
        async () => (await readFile(s.filePath, 'utf8')) === 'hello world\n',
        10_000,
        'human edit re-materialized',
      )
      expect(s.bridge.turns).toBe(0) // human edits never open a turn
      expect(s.bridge.baseText).toBe('hello world\n')
    } finally {
      await s.teardown()
    }
  })

  it('a lone agent edit lands in every replica', async () => {
    const s = await setupScenario('smoke-agent', 'alpha\nbeta\n')
    try {
      await waitUntil(async () => (await readFile(s.filePath, 'utf8')) === 'alpha\nbeta\n')
      await s.agent.edit('beta', 'BETA')
      const file = await s.settle(1)
      expect(file).toBe('alpha\nBETA\n')
      expect(s.all()).toEqual(['alpha\nBETA\n', 'alpha\nBETA\n', 'alpha\nBETA\n'])
    } finally {
      await s.teardown()
    }
  })
})

describe('D25 acceptance', () => {
  it('(a) concurrent non-overlapping human + agent edits both survive', async () => {
    const seed = '# Doc\n\nalpha\n\ngamma\n'
    const s = await setupScenario('accept-a', seed)
    try {
      await waitUntil(async () => (await readFile(s.filePath, 'utf8')) === seed)
      s.h1.insertAfter('alpha', ' (H1)')
      await s.agent.edit('gamma', 'gamma (A1)')
      const file = await s.settle(1)
      expect(file).toContain('alpha (H1)')
      expect(file).toContain('gamma (A1)')
      expect(converged([...s.all(), file])).toBe(true)
    } finally {
      await s.teardown()
    }
  })

  it('(c) remote edits landing mid-agent-turn do not poison the diff', async () => {
    const seed = 'one\ntwo\nthree\n'
    const s = await setupScenario('accept-c', seed, { turnIdleMs: 500 })
    try {
      await waitUntil(async () => (await readFile(s.filePath, 'utf8')) === seed)

      await s.agent.edit('one', 'ONE') // opens the turn
      await waitUntil(() => s.bridge.isTurnActive, 5_000, 'turn opened')

      // Remote human edit lands while the turn is active — buffered in the
      // live CRDT, invisible to the frozen file:
      s.h1.insertAfter('three', '\nfour (remote mid-turn)')
      await sleep(100)
      expect(await readFile(s.filePath, 'utf8')).not.toContain('four (remote mid-turn)') // frozen

      await s.agent.edit('three', 'THREE') // extends the same turn
      const file = await s.settle(1)

      expect(file).toContain('ONE')
      expect(file).toContain('THREE')
      expect(file).toContain('four (remote mid-turn)')
      expect(file).toContain('two') // untouched region intact
      expect(converged([...s.all(), file])).toBe(true)
    } finally {
      await s.teardown()
    }
  })
})
