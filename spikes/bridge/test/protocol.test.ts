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

describe('D25 acceptance — watcher coalescing (e)', () => {
  it('rapid Write+Edit+Edit within the idle window coalesce into ONE turn; separate bursts land as separate turns', async () => {
    const seed = 'title\nbody\nfooter\n'
    const s = await setupScenario('accept-e', seed, { turnIdleMs: 400 })
    try {
      await waitUntil(async () => (await readFile(s.filePath, 'utf8')) === seed)

      // Burst 1: three rapid ops, all inside one idle window
      await s.agent.write('title v2\nbody\nfooter\n')
      await s.agent.edit('body', 'body v2')
      await s.agent.edit('footer', 'footer v2')
      const file1 = await s.settle(1)
      expect(s.bridge.turns).toBe(1) // coalesced — not three turns
      expect(file1).toBe('title v2\nbody v2\nfooter v2\n')

      // Burst 2 after idle: a distinct second turn, nothing dropped
      await s.agent.edit('title v2', 'title v3')
      const file2 = await s.settle(2)
      expect(s.bridge.turns).toBe(2)
      expect(file2).toBe('title v3\nbody v2\nfooter v2\n')
      expect(converged([...s.all(), file2])).toBe(true)
    } finally {
      await s.teardown()
    }
  })
})

describe('documented residual risk — stale agent writes (why CC read-before-edit is load-bearing)', () => {
  it('a Write derived from a stale Read silently reverts a remote edit — the exact case CC refuses natively', async () => {
    const seed = 'alpha\nAGENT:\n'
    const s = await setupScenario('stale-write', seed)
    try {
      await waitUntil(async () => (await readFile(s.filePath, 'utf8')) === seed)

      const staleRead = await s.agent.read() // agent "Read" now…

      // …then a human edit lands and re-materializes:
      s.h1.insertAfter('alpha', ' h1#')
      await waitUntil(
        async () => (await readFile(s.filePath, 'utf8')).includes('h1#'),
        10_000,
        'human edit re-materialized',
      )

      // Agent writes content derived from the STALE read (bypassing the guard
      // Claude Code enforces: Write/Edit fail if the file changed since Read):
      await s.agent.write(staleRead.replace('AGENT:', 'AGENT: a1#'))
      const file = await s.settle(1)

      // Convergent, but the human edit is gone — diff(base-with-h1#, stale file)
      // legitimately reads as "agent deleted h1#". This is NOT a bridge bug:
      // the bridge cannot distinguish stale-revert from intentional delete.
      // Defense: CC's native modification-detection (D2) + D26 safety net.
      expect(file).toContain('a1#')
      expect(file).not.toContain('h1#')
      expect(converged([...s.all(), file])).toBe(true)
    } finally {
      await s.teardown()
    }
  })
})
