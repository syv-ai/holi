import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createMdxConsentStore } from '../src/main/mdx-consent'
import { within } from './fixtures/fixture-deadline'
import { REMOTE, gate, resourceRig } from './fixtures/mdx-router'

const entry = 'https://one.example/entry.js'
const externalSource = `import '${entry}?opaque=value'\n`

it('requires separate consent for a static import, its redirect, and a transitive external re-export', async () => {
  const { root, mdx, acquire, contacts, routes, changed } = await resourceRig()
  const owner = await acquire()
  const secondView = await acquire()
  const source = `${externalSource}import './local.js'\n`
  await writeFile(join(root, 'local.js'), 'export const local = 1')
  const redirected = 'https://two.example/lib/main.mjs'
  const child = 'https://two.example/lib/child.js'
  const transit = 'https://three.example/leaf.js'
  routes.set(`${entry}?opaque=value`, { redirect: redirected })
  routes.set(redirected, { text: "export * from './child.js'" })
  routes.set(child, { text: `export * from '${transit}'` })
  routes.set(transit, { text: 'export const leaf = 3' })
  const diagnose = (generation: number) => mdx.compile({ ...owner, generation, source })
  await mdx.compile({ ...secondView, generation: 1, source })
  for (const [index, origin] of [
    'https://one.example',
    'https://two.example',
    'https://three.example',
  ].entries()) {
    const generation = index + 1
    expect(await diagnose(generation)).not.toHaveLength(0)
    const control = await mdx.externalResources(owner)
    expect(control).toMatchObject({
      generation,
      pending: [{ origin, purpose: 'mdx-dependency-diagnostics' }],
    })
    expect(control.approved).toHaveLength(index)
    expect(JSON.stringify(control)).not.toContain('opaque=value')
    expect(contacts.some((url) => new URL(url).origin === origin)).toBe(false)
    const requestId = control.pending[0]!.id
    await expect(mdx.approveExternalResource({ ...secondView, requestId })).rejects.toThrow()
    if (index === 0) {
      const splitId = (await mdx.externalResources(secondView)).pending[0]!.id
      const granted = await Promise.allSettled([
        mdx.approveExternalResource({ ...owner, requestId }),
        mdx.approveExternalResource({ ...secondView, requestId: splitId }),
      ])
      expect(granted.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    } else {
      await mdx.approveExternalResource({ ...owner, requestId })
    }
    expect((await mdx.externalResources(secondView)).pending).toEqual([])
  }
  expect(changed).toEqual([REMOTE, REMOTE, REMOTE])
  expect(await diagnose(4)).toEqual([])
  expect(contacts).toContain(child)
  expect(contacts).not.toContain('https://one.example/child.js')

  routes.set(child, {
    text: "import './style.css'; import 'some-package'; import('./dynamic.js'); module.exports = 1",
  })
  routes.set('https://two.example/lib/style.css', { text: 'body { color: var(--foreground) }' })
  expect(await diagnose(5)).toHaveLength(3)
  expect((await mdx.externalResources(owner)).pending).toEqual([])
  expect(contacts).toContain('https://two.example/lib/style.css')
  expect(contacts).not.toContain('https://two.example/lib/dynamic.js')

  await mdx.releaseDiagnosticsLease(owner)
  await mdx.releaseDiagnosticsLease(secondView)
})

it.each(['transitive import', 'redirect chain'] as const)(
  'retires a pending and admitted approval discovered through a revoked %s',
  async (discovery) => {
    const reachedStore = gate()
    const writeCanContinue = gate()
    const parent = 'https://parent.example/entry.js'
    const middle = 'https://middle.example/entry.js'
    const child = 'https://child.example/entry.js'
    const independent = 'https://independent.example/entry.js'
    const revokedUrl = discovery === 'redirect chain' ? middle : parent
    const childOrigin = new URL(child).origin
    const { mdx, acquire, routes, contacts, consentFile, root } = await resourceRig(false, {
      consent: (store) => ({
        ...store,
        async grant(scope, stillOwned) {
          if (scope.origin === childOrigin) {
            reachedStore.resolve()
            await writeCanContinue.promise
          }
          await store.grant(scope, stillOwned)
        },
      }),
    })
    const linked = (url: string) =>
      discovery === 'redirect chain' ? { redirect: url } : { text: `export * from '${url}'` }
    routes.set(parent, linked(middle))
    routes.set(middle, linked(child))
    routes.set(child, { text: 'export const child = true' })
    routes.set(independent, { text: 'export const independent = true' })
    const owners = [await acquire(), await acquire(), await acquire()] as const
    const [inFlight, pending, other] = owners
    const source = `import '${parent}'\n`
    const compile = (owner: { lease: string }, generation: number, text = source) =>
      mdx.compile({ ...owner, generation, source: text })
    const request = async (owner: { lease: string }, url: string) => ({
      ...owner,
      requestId: (await mdx.externalResources(owner)).pending.find(
        ({ origin }) => origin === new URL(url).origin,
      )!.id,
    })
    try {
      await compile(inFlight, 1)
      await mdx.approveExternalResource(await request(inFlight, parent))
      await compile(inFlight, 2)
      await mdx.approveExternalResource(await request(inFlight, middle))
      await compile(inFlight, 3)
      // Deduplicating a direct and indirect discovery into one offer must not erase
      // the dependency on the upstream grant.
      await compile(pending, 1, `import '${child}'\n${source}`)
      await compile(other, 1, `import '${independent}'\n`)
      const obsolete = await request(pending, child)
      const unrelated = await request(other, independent)
      const revokedOrigin = new URL(revokedUrl).origin
      const grant = (await mdx.externalResources(other)).approved.find(
        ({ origin }) => origin === revokedOrigin,
      )!
      const admitted = expect(
        mdx.approveExternalResource(await request(inFlight, child)),
      ).rejects.toThrow()
      await within(reachedStore.promise, 3_000, 'admit the dependent approval')
      await mdx.revokeExternalResource({ ...other, grantId: grant.id })
      expect((await mdx.externalResources(pending)).pending).toEqual([])
      writeCanContinue.resolve()
      await admitted
      await expect(mdx.approveExternalResource(obsolete)).rejects.toThrow()
      await expect(mdx.approveExternalResource(unrelated)).resolves.toEqual({ ok: true })
      await expect(compile(other, 2, `import '${independent}'\n`)).resolves.toEqual([])
      await compile(inFlight, 4)
      expect(contacts).toContain(independent)
      expect(contacts).not.toContain(child)
      expect(
        await createMdxConsentStore(consentFile).allows({
          root: await realpath(root),
          remote: REMOTE,
          accountId: '42',
          origin: childOrigin,
        }),
      ).toBe(false)
    } finally {
      writeCanContinue.resolve()
      for (const owner of owners) await mdx.releaseDiagnosticsLease(owner)
    }
  },
)

it.each([
  { reference: 'canonical URL', first: 'left', second: 'right' },
  { reference: 'canonical URL', first: 'right', second: 'left' },
  { reference: 'redirect alias', first: 'left', second: 'right' },
  { reference: 'redirect alias', first: 'right', second: 'left' },
])(
  'retires a shared child offer through a cached $reference when the later $second branch is revoked',
  async ({ reference, first, second }) => {
    const branch = (side: string) => `https://${side}.example/branch.js`
    const shared = 'https://shared.example/module.js'
    const relay = 'https://shared.example/relay.js'
    const alias = 'https://alias.example/redirect.js'
    const child = 'https://child.example/leaf.js'
    const independent = 'https://independent.example/entry.js'
    const originOf = (url: string) => new URL(url).origin
    const throughAlias = reference === 'redirect alias'
    const reachedStore = gate()
    const resumeApproval = gate()
    const { mdx, acquire, root, consentFile, routes, contacts } = await resourceRig(false, {
      consent: (store) => ({
        ...store,
        async grant(scope, stillOwned) {
          if (scope.origin === originOf(child)) {
            reachedStore.resolve()
            await resumeApproval.promise
          }
          await store.grant(scope, stillOwned)
        },
      }),
    })
    const scope = { root: await realpath(root), remote: REMOTE, accountId: '42' }
    const store = createMdxConsentStore(consentFile)
    for (const url of [branch(first), branch(second), shared, ...(throughAlias ? [alias] : [])])
      await store.grant({ ...scope, origin: originOf(url) })
    for (const side of [first, second])
      routes.set(branch(side), { text: `export * from '${throughAlias ? alias : shared}'` })
    routes.set(alias, { redirect: shared })
    routes.set(shared, { text: "export * from './relay.js'" })
    routes.set(relay, { text: `export * from '${child}'` })
    await writeFile(
      join(root, 'branches.js'),
      `import '${branch(first)}'\nimport '${branch(second)}'\n`,
    )
    const source = `import './branches.js'\nimport '${independent}'\n`
    const pending = await acquire()
    const inFlight = await acquire()
    const findId = (entries: { origin: string; id: string }[], url: string) =>
      entries.find(({ origin }) => origin === originOf(url))!.id
    try {
      const expectedContacts = [
        branch(first),
        ...(throughAlias ? [alias] : []),
        shared,
        relay,
        branch(second),
      ].sort()
      await mdx.compile({ ...pending, source, generation: 1 })
      expect([...contacts].sort()).toEqual(expectedContacts)
      await mdx.compile({ ...inFlight, source, generation: 1 })
      const control = await mdx.externalResources(pending)
      const obsolete = { ...pending, requestId: findId(control.pending, child) }
      const unrelated = { ...pending, requestId: findId(control.pending, independent) }
      const grantId = findId(control.approved, branch(second))
      const admitted = mdx
        .approveExternalResource({
          ...inFlight,
          requestId: findId((await mdx.externalResources(inFlight)).pending, child),
        })
        .then(
          () => 'approved',
          () => 'denied',
        )
      try {
        await within(reachedStore.promise, 3_000, 'admit the shared child approval')
        await mdx.revokeExternalResource({ ...pending, grantId })
      } finally {
        resumeApproval.resolve()
        await admitted
      }
      expect(await admitted).toBe('denied')
      expect((await mdx.externalResources(pending)).pending).toMatchObject([
        { origin: originOf(independent), id: unrelated.requestId },
      ])
      await expect(mdx.approveExternalResource(obsolete)).rejects.toThrow()
      await expect(mdx.approveExternalResource(unrelated)).resolves.toEqual({ ok: true })
      expect(await store.allows({ ...scope, origin: originOf(child) })).toBe(false)
      expect(await store.allows({ ...scope, origin: originOf(independent) })).toBe(true)
      expect([...contacts].sort()).toEqual([...expectedContacts, ...expectedContacts].sort())
    } finally {
      await mdx.releaseDiagnosticsLease(pending)
      await mdx.releaseDiagnosticsLease(inFlight)
    }
  },
)
