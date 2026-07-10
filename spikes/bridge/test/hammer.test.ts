import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hocuspocus } from '@hocuspocus/server'
import { AgentSim } from '../src/agent'
import { BridgeClient } from '../src/bridge-client'
import {
  connectDoc,
  converged,
  countOccurrences,
  SimClient,
  sleep,
  startRelay,
  waitUntil,
} from '../src/harness'

const PORT = 5402
const URL = `ws://127.0.0.1:${PORT}`

let relay: Hocuspocus
beforeAll(async () => {
  relay = await startRelay(PORT)
})
afterAll(async () => {
  await relay.destroy()
})

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Agent activity is burst-shaped ON PURPOSE: the harness detects turn end by
// watcher idle, so an agent op landing in the same instant a turn ends races
// endTurn's read↔rematerialize window (see spike report). The hammer's job is
// lost-update detection under concurrency; humans edit continuously with no
// coordination at all.
describe('D25 acceptance — randomized hammer (d): no lost updates', () => {
  it('humans hammer continuously while the agent edits in bursts; every marker survives exactly once', async () => {
    const rnd = mulberry32(0xd25)
    const seed =
      ['# Hammer', 'L1:', 'L2:', 'L3:', 'L4:', 'L5:', 'L6:', 'L7:', 'L8:', 'AGENT:'].join('\n') +
      '\n'

    const dir = await mkdtemp(join(tmpdir(), 'bridge-hammer-'))
    const filePath = join(dir, 'doc.md')
    const h1 = new SimClient(URL, 'hammer')
    const h2 = new SimClient(URL, 'hammer')
    h1.text.insert(0, seed)
    await waitUntil(() => h2.toString() === seed, 10_000, 'seed propagated')

    const bridge = new BridgeClient(filePath, { turnIdleMs: 300 })
    const conn = connectDoc(URL, 'hammer', bridge.doc)
    await waitUntil(() => bridge.text.toString() === seed, 10_000, 'bridge synced')
    await bridge.start()
    const agent = new AgentSim(filePath)
    await waitUntil(async () => (await readFile(filePath, 'utf8')) === seed)

    const tokens: string[] = []
    let n = 0
    const humanOp = (who: SimClient, tag: string) => {
      const token = ` ${tag}-${++n}#`
      who.insertAfter(`L${1 + Math.floor(rnd() * 8)}:`, token)
      tokens.push(token.trim())
    }

    const BURSTS = 8
    for (let burst = 1; burst <= BURSTS; burst++) {
      const agentOps = 2 + Math.floor(rnd() * 3) // 2–4 ops per burst
      for (let op = 0; op < agentOps; op++) {
        const token = `a${++n}#`
        if (rnd() < 0.3) {
          // full-file rewrite (CC Write after Read): append to the AGENT line
          const current = await agent.read()
          await agent.write(
            current
              .split('\n')
              .map((line) => (line.startsWith('AGENT:') ? `${line} ${token}` : line))
              .join('\n'),
          )
        } else {
          // targeted replace (CC Edit)
          await agent.edit('AGENT:', `AGENT: ${token}`)
        }
        tokens.push(token)
        humanOp(h1, 'h1')
        humanOp(h2, 'h2')
        await sleep(30 + rnd() * 60)
      }
      // quiet gap ends the turn; humans keep going regardless
      humanOp(h1, 'h1')
      humanOp(h2, 'h2')
      await sleep(700)
    }

    // Settle: no active turn, all replicas + disk converged
    await waitUntil(() => !bridge.isTurnActive, 20_000, 'final turn released')
    const all = () => [h1.toString(), h2.toString(), bridge.text.toString()]
    await waitUntil(() => converged(all()), 15_000, 'replicas converged')
    await sleep(300)
    const file = await readFile(filePath, 'utf8')
    expect(converged([...all(), file])).toBe(true)

    // The heart of acceptance (d): nothing lost, nothing duplicated
    const missing = tokens.filter((t) => countOccurrences(file, t) === 0)
    const duplicated = tokens.filter((t) => countOccurrences(file, t) > 1)
    console.log(
      `[spike] hammer: ${tokens.length} markers, ${bridge.turns} agent turns, ` +
        `${missing.length} missing, ${duplicated.length} duplicated`,
    )
    expect(missing).toEqual([])
    expect(duplicated).toEqual([])
    expect(bridge.turns).toBeGreaterThanOrEqual(4)

    await bridge.stop()
    conn.destroy()
    h1.destroy()
    h2.destroy()
    await rm(dir, { recursive: true, force: true })
  })
})
