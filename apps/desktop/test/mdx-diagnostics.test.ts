import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createMdxDiagnostics } from '../src/main/mdx-diagnostics'

const roots: string[] = []
const identity = {
  accountGeneration: 1,
  accountId: 'account',
  remote: 'owner/notes',
  openRevision: 1,
  active: {},
}
const gate = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}
async function fixture(
  overrides: { root?: () => Promise<string>; trusted?: () => Promise<boolean> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'holi-mdx-diagnostics-'))
  roots.push(root)
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs/page.mdx'), '# Page')
  let allowed = true
  const diagnostics = createMdxDiagnostics({
    authorize: () => allowed,
    context: () => identity,
    root: overrides.root ?? (async () => root),
    trusted: overrides.trusted ?? (async () => true),
    compile: async () => [],
  })
  return { diagnostics, root, revoke: () => (allowed = false) }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('MDX diagnostics lease acquisition', () => {
  test('invalidate cancels an acquisition awaiting its root', async () => {
    const rootGate = gate<string>()
    const { diagnostics, root } = await fixture({ root: () => rootGate.promise })
    const acquisition = diagnostics.acquire({
      remote: identity.remote,
      path: 'docs/page.mdx',
      context: 'token',
    })
    diagnostics.invalidate()
    rootGate.resolve(root)
    await expect(acquisition).rejects.toThrow('MDX context changed')
    await expect(
      diagnostics.acquire({ remote: identity.remote, path: 'docs/page.mdx', context: 'token' }),
    ).resolves.toBeDefined()
    diagnostics.close()
  })

  test('close cancels an acquisition while trust is being checked', async () => {
    const trustGate = gate<boolean>()
    const { diagnostics } = await fixture({ trusted: () => trustGate.promise })
    const acquisition = diagnostics.acquire({
      remote: identity.remote,
      path: 'docs/page.mdx',
      context: 'token',
    })
    diagnostics.close()
    trustGate.resolve(true)
    await expect(acquisition).rejects.toThrow('MDX context changed')
  })

  test('invalid paths do not reserve pending capacity', async () => {
    const { diagnostics } = await fixture()
    await expect(
      diagnostics.acquire({ remote: identity.remote, path: '../escape.mdx', context: 'token' }),
    ).rejects.toThrow()
    const leases = await Promise.all(
      Array.from({ length: 4 }, () =>
        diagnostics.acquire({
          remote: identity.remote,
          path: 'docs/page.mdx',
          context: 'token',
        }),
      ),
    )
    expect(leases).toHaveLength(4)
    diagnostics.close()
  })

  test('pending acquisitions reserve capacity', async () => {
    const rootGate = gate<string>()
    const { diagnostics, root } = await fixture({ root: () => rootGate.promise })
    const requests = Array.from({ length: 5 }, () =>
      diagnostics.acquire({ remote: identity.remote, path: 'docs/page.mdx', context: 'token' }),
    )
    await expect(requests[4]).rejects.toThrow('lease limit')
    diagnostics.invalidate()
    rootGate.resolve(root)
    await Promise.all(requests.slice(0, 4).map((request) => expect(request).rejects.toThrow()))
    diagnostics.close()
  })

  test('path invalidation cancels only matching leases and pending acquisitions', async () => {
    const rootGate = gate<string>()
    const { diagnostics, root } = await fixture({ root: () => rootGate.promise })
    const pending = diagnostics.acquire({
      remote: identity.remote,
      path: 'docs/page.mdx',
      context: 'token',
    })
    diagnostics.invalidatePath(identity.remote, 'docs')
    rootGate.resolve(root)
    await expect(pending).rejects.toThrow('MDX context changed')
    const page = await diagnostics.acquire({
      remote: identity.remote,
      path: 'docs/page.mdx',
      context: 'token',
    })
    const other = await diagnostics
      .acquire({
        remote: identity.remote,
        path: 'unrelated.mdx',
        context: 'token',
      })
      .catch(async () => {
        await writeFile(join(root, 'unrelated.mdx'), '# other')
        return diagnostics.acquire({
          remote: identity.remote,
          path: 'unrelated.mdx',
          context: 'token',
        })
      })
    diagnostics.invalidatePath(identity.remote, 'docs/page.mdx')
    await expect(
      diagnostics.compile({ lease: page.lease, generation: 1, source: '# invalidated' }),
    ).rejects.toThrow()
    await expect(
      diagnostics.compile({ lease: other.lease, generation: 1, source: '# still live' }),
    ).resolves.toEqual([])
    diagnostics.close()
  })

  test('cancellation during the final path check cannot return diagnostics', async () => {
    const finalTrust = gate<boolean>()
    let trustedCalls = 0
    const { diagnostics } = await fixture({
      trusted: async () => {
        trustedCalls += 1
        if (trustedCalls === 11) return finalTrust.promise
        return true
      },
    })
    const lease = await diagnostics.acquire({
      remote: identity.remote,
      path: 'docs/page.mdx',
      context: 'token',
    })
    const compiling = diagnostics.compile({ lease: lease.lease, generation: 1, source: '# page' })
    while (trustedCalls < 11) await new Promise((resolve) => setTimeout(resolve, 0))
    diagnostics.cancel({ lease: lease.lease, generation: 2 })
    finalTrust.resolve(true)
    await expect(compiling).rejects.toThrow(/superseded|cancelled/i)
    diagnostics.close()
  })

  test('a rejected final trust check closes its unpublished watcher and frees capacity', async () => {
    let trustedCalls = 0
    const { diagnostics } = await fixture({
      trusted: async () => {
        trustedCalls += 1
        if (trustedCalls === 6) throw new Error('trust store unavailable')
        return true
      },
    })
    await expect(
      diagnostics.acquire({ remote: identity.remote, path: 'docs/page.mdx', context: 'token' }),
    ).rejects.toThrow('trust store unavailable')
    const leases = await Promise.all(
      Array.from({ length: 4 }, () =>
        diagnostics.acquire({ remote: identity.remote, path: 'docs/page.mdx', context: 'token' }),
      ),
    )
    expect(leases).toHaveLength(4)
    diagnostics.close()
  })

  test('replacement of the leased file fails closed', async () => {
    const { diagnostics, root } = await fixture()
    const lease = await diagnostics.acquire({
      remote: identity.remote,
      path: 'docs/page.mdx',
      context: 'token',
    })
    const replacement = join(root, 'docs/replacement.mdx')
    await writeFile(replacement, '# Page')
    await rename(replacement, join(root, 'docs/page.mdx'))
    await expect(
      diagnostics.compile({ lease: lease.lease, generation: 1, source: '# page' }),
    ).rejects.toThrow('MDX context changed')
    diagnostics.close()
  })

  test('revoke during root resolution prevents lease publication', async () => {
    const rootGate = gate<string>()
    const { diagnostics, root, revoke } = await fixture({ root: () => rootGate.promise })
    const acquisition = diagnostics.acquire({
      remote: identity.remote,
      path: 'docs/page.mdx',
      context: 'token',
    })
    revoke()
    rootGate.resolve(root)
    await expect(acquisition).rejects.toThrow()
    diagnostics.close()
  })
})
