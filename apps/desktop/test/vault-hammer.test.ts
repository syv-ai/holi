import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hocuspocus } from '@hocuspocus/server'
import type { DocMeta } from '@holi/shared'
import { VaultMirror, type MirrorApi } from '../src/main/vault/vault-mirror'
import { AgentSim, converged, countOccurrences, SimClient, sleep, startRelay, waitUntil } from './helpers/relay'

const PORT = 5613
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

describe('acceptance (d) against the real mirror: no lost updates', () => {
  it('humans hammer continuously while the agent edits in bursts; every marker survives exactly once', async () => {
    const rnd = mulberry32(0xd25)
    const seed = ['# Hammer', 'L1:', 'L2:', 'L3:', 'L4:', 'L5:', 'L6:', 'L7:', 'L8:', 'AGENT:'].join('\n') + '\n'
    const docMeta: DocMeta = { id: randomUUID(), vaultId: 'v', path: 'hammer.md', kind: 'note', createdAt: '', updatedAt: '' }

    const h1 = new SimClient(URL, docMeta.id)
    const h2 = new SimClient(URL, docMeta.id)
    h1.text.insert(0, seed)
    await waitUntil(() => h2.toString() === seed, 10_000, 'seed propagated')

    const dir = await mkdtemp(join(tmpdir(), 'holi-hammer-'))
    const root = join(dir, 'work')
    const api: MirrorApi = {
      listDocs: async () => [docMeta],
      createNote: async () => {
        throw new Error('unexpected create')
      },
      deleteNote: async () => {},
      takeSnapshot: async () => {},
    }
    const mirror = new VaultMirror({
      vaultId: 'v',
      workRoot: root,
      baseDir: join(dir, 'bases'),
      docStateDir: join(dir, 'docstate'),
      relayUrl: URL,
      token: 'tok',
      api,
      turnIdleMs: 300,
    })
    await mirror.start()
    const filePath = join(root, 'hammer.md')
    await waitUntil(async () => (await readFile(filePath, 'utf8').catch(() => null)) === seed, 10_000, 'materialized')
    const agent = new AgentSim(filePath)

    const tokens: string[] = []
    let n = 0
    const humanOp = (who: SimClient, tag: string) => {
      const token = ` ${tag}-${++n}#`
      who.insertAfter(`L${1 + Math.floor(rnd() * 8)}:`, token)
      tokens.push(token.trim())
    }

    const BURSTS = 8
    for (let burst = 1; burst <= BURSTS; burst++) {
      const agentOps = 2 + Math.floor(rnd() * 3)
      for (let op = 0; op < agentOps; op++) {
        const token = `a${++n}#`
        if (rnd() < 0.3) {
          const current = await agent.read()
          await agent.write(
            current.split('\n').map((line) => (line.startsWith('AGENT:') ? `${line} ${token}` : line)).join('\n'),
          )
        } else {
          await agent.edit('AGENT:', `AGENT: ${token}`)
        }
        tokens.push(token)
        humanOp(h1, 'h1')
        humanOp(h2, 'h2')
        await sleep(30 + rnd() * 60)
      }
      humanOp(h1, 'h1')
      humanOp(h2, 'h2')
      await sleep(700)
    }

    const all = () => [h1.toString(), h2.toString()]
    await waitUntil(() => converged(all()), 20_000, 'replicas converged')
    await sleep(600) // final re-materialization settles
    const file = await readFile(filePath, 'utf8')
    expect(converged([...all(), file])).toBe(true)

    const missing = tokens.filter((t) => countOccurrences(file, t) === 0)
    const duplicated = tokens.filter((t) => countOccurrences(file, t) > 1)
    console.log(`[hammer] ${tokens.length} markers, ${missing.length} missing, ${duplicated.length} duplicated`)
    expect(missing).toEqual([])
    expect(duplicated).toEqual([])

    await mirror.stop()
    h1.destroy()
    h2.destroy()
    await rm(dir, { recursive: true, force: true })
  }, 120_000)
})
