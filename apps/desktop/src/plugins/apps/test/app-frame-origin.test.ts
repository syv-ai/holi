import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppFrameLeases } from '../../../main/plugin-host/app-frame-leases'
import { serveScheme, type SchemeEntry } from '../../../main/plugin-host/schemes'
import { appScheme } from '../main/protocol'
import { leasedAppHost } from '../shared/bundle'

const bundle = 'Same/Tool.app'
const roots: string[] = []

function fakeWindow(): import('electron').BrowserWindow {
  return { isDestroyed: () => false } as import('electron').BrowserWindow
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function vault(remote: string, body: string) {
  const root = await mkdtemp(join(tmpdir(), 'holi-app-origin-'))
  roots.push(root)
  await mkdir(join(root, bundle), { recursive: true })
  await writeFile(join(root, bundle, 'same.js'), body)
  return { remote, root }
}

describe('leased app resource origin', () => {
  it('serves the lease owner across a deferred enablement check, never the active vault', async () => {
    const a = await vault('team/a', 'A')
    const b = await vault('team/b', 'B')
    const frames = createAppFrameLeases()
    const winA = fakeWindow()
    const winB = fakeWindow()
    const leaseA = frames.issue({
      ...a,
      bundle,
      activation: 1,
      window: winA,
      current: () => true,
    })
    const leaseB = frames.issue({
      ...b,
      bundle,
      activation: 1,
      window: winB,
      current: () => true,
    })
    const windowByHost = new Map([
      [leasedAppHost(bundle, leaseA.token), winA],
      [leasedAppHost(bundle, leaseB.token), winB],
    ])
    let enabledA!: () => void
    const waitingA = new Promise<void>((resolve) => (enabledA = resolve))
    let active: { remote: string; root: string } | null = b
    const serve = serveScheme({ owner: 'apps', scheme: appScheme } satisfies SchemeEntry, {
      active: () => active,
      runs: async (_owner, root) => {
        if (root === a.root) await waitingA
        return true
      },
      appFrames: frames,
      windowForRequest: (request) => windowByHost.get(new URL(request.url).hostname) ?? null,
    })
    const request = (token: string) =>
      new Request(`holi-app://${leasedAppHost(bundle, token)}/same.js`)
    const readA = serve(request(leaseA.token))
    active = a
    const readB = serve(request(leaseB.token))
    enabledA()
    const [responseA, responseB] = await Promise.all([readA, readB])
    expect(await responseA.text()).toBe('A')
    expect(await responseB.text()).toBe('B')
  })

  it('refuses a lease from another window, a revoked lease, and invalidated A→B→A authority', async () => {
    const a = await vault('team/a', 'A')
    const frames = createAppFrameLeases()
    const win = fakeWindow()
    const lease = frames.issue({ ...a, bundle, activation: 5, window: win, current: () => true })
    expect(frames.resolve(lease.token, fakeWindow())).toBeNull()
    expect(
      frames.validate({
        token: lease.token,
        nonce: lease.nonce,
        window: win,
        remote: 'team/other',
        bundle,
      }),
    ).toBeNull()
    frames.revokeActivation('team/a', 5)
    expect(frames.resolve(lease.token, win)).toBeNull()
    const replacement = frames.issue({
      ...a,
      bundle,
      activation: 6,
      window: win,
      current: () => true,
    })
    frames.revokeRemote('team/a')
    expect(frames.resolve(replacement.token, win)).toBeNull()
  })

  it('allows exactly one document load per lease', async () => {
    const a = await vault('team/a', 'A')
    const frames = createAppFrameLeases()
    const lease = frames.issue({
      ...a,
      bundle,
      activation: 1,
      window: fakeWindow(),
      current: () => true,
    })
    expect(lease.claimDocument()).toBe(true)
    expect(lease.claimDocument()).toBe(false)
  })
})
