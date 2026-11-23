import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentProbeOwner } from '../main/probe-owner'
import { harnessCapabilities } from '../main/harness/capabilities'
import type { HarnessRegistry } from '../main/harness/registry'

const windows = process.platform === 'win32'
const roots: string[] = []
const owned = new Set<number>()

afterEach(async () => {
  for (const pid of owned) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  owned.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'holi-harness-drain-'))
  roots.push(root)
  const script = join(root, 'fixture.cjs')
  const trigger = join(root, 'continue')
  const ready = join(root, 'ready.json')
  await writeFile(
    script,
    `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const mode = process.argv[2];
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify({root:process.ppid,child:process.pid,group:process.ppid})); process.stdout.write('DESCENDANT_READY\\n'); setInterval(()=>{},1000)`)}], { stdio: ['ignore','inherit','inherit'] });
process.stdout.write(JSON.stringify({root:process.pid, child:child.pid, group:process.pid})+'\\n');
const poll=setInterval(()=>{ if(fs.existsSync(${JSON.stringify(trigger)})){ clearInterval(poll); if(mode==='output') process.stdout.write('x'.repeat(270*1024)); else if(mode==='zero') process.stdout.write('fixture success\\n'); else if(mode==='nonzero') process.stdout.write('fixture failure\\n'); if(mode==='nonzero') process.exit(7); if(mode==='zero'||mode==='nonzero') process.exit(mode==='zero'?0:7); } },10);
`,
  )
  return { root, script, trigger, ready }
}

const registryFor = (script: string, mode: string) =>
  ({
    get: () => ({ env: {}, test: [script, mode] }),
    resolve: () => process.execPath,
  }) as unknown as HarnessRegistry

async function waitForFile(path: string, deadline: number) {
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as {
        root: number
        child: number
        group: number
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error('fixture readiness deadline exceeded')
}

async function assertGone(ids: { root: number; child: number; group: number }) {
  for (let attempt = 0; attempt < 100; attempt++) {
    let live = false
    for (const pid of [ids.root, ids.child]) {
      try {
        process.kill(pid, 0)
        live = true
      } catch {}
    }
    try {
      process.kill(-ids.group, 0)
      live = true
    } catch {}
    if (!live) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect.fail(`owned process group ${ids.group} remained after harness result`)
}

describe.skipIf(windows)('POSIX harness process drainage', () => {
  test.each([
    { mode: 'cancel', outcome: 'cancel' },
    { mode: 'output', outcome: 'limit' },
    { mode: 'zero', outcome: 'success' },
    { mode: 'nonzero', outcome: 'failure' },
  ])(
    '$outcome waits for resistant descendant drainage',
    async ({ mode, outcome }) => {
      const f = await fixture()
      const controller = new AbortController()
      const probes = createAgentProbeOwner(controller.signal)
      const caps = harnessCapabilities({
        registry: registryFor(f.script, mode),
        probes,
        file: 'fixture.json',
        root: () => f.root,
        changed() {},
      })
      const answer = caps['agent.harnessTest'].run(
        { remote: 'fixture/vault', root: f.root } as never,
        { id: 'fixture' },
      )
      const ids = await waitForFile(f.ready, Date.now() + 2_000)
      owned.add(ids.root)
      owned.add(ids.child)
      // The child creates the readiness record only after its SIGTERM handler is installed.
      if (outcome === 'cancel') controller.abort()
      else if (outcome === 'limit') await writeFile(f.trigger, '')
      else await writeFile(f.trigger, '')
      const result = await answer
      if (outcome === 'cancel') expect(result).toMatchObject({ ok: false })
      if (outcome === 'limit') expect(result).toMatchObject({ ok: false })
      if (outcome === 'success') expect(result).toMatchObject({ ok: true })
      if (outcome === 'failure') expect(result).toMatchObject({ ok: false })
      expect(result.output.length).toBeLessThanOrEqual(4_000)
      await assertGone(ids)
      await probes.stop()
    },
    12_000,
  )
})
