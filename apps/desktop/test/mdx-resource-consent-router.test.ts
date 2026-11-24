import { Resolver } from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import { requestFlush } from '../src/main/flush'
import { createMdxConsentStore } from '../src/main/mdx-consent'
import { guardNavigation } from '../src/main/window-guard'
import { createMdxExternalNetworkFixture } from './fixtures/mdx-external-network'
import { within } from './fixtures/fixture-deadline'
import { auth, REMOTE, gate, rig, resourceRig } from './fixtures/mdx-router'

const entry = 'https://one.example/entry.js'
const externalSource = `import '${entry}?opaque=value'\n`

it('opens a consent request for the production fetcher without resolving DNS', async () => {
  const { acquire, mdx } = await resourceRig(true)
  const dns4 = vi.spyOn(Resolver.prototype, 'resolve4').mockRejectedValue({ code: 'ENODATA' })
  const dns6 = vi.spyOn(Resolver.prototype, 'resolve6').mockRejectedValue({ code: 'ENODATA' })
  const owner = await acquire()
  try {
    expect(await mdx.compile({ ...owner, generation: 1, source: externalSource })).toHaveLength(1)
    expect((await mdx.externalResources(owner)).pending).toMatchObject([
      { origin: 'https://one.example' },
    ])
    expect(dns4).not.toHaveBeenCalled()
    expect(dns6).not.toHaveBeenCalled()
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
    dns4.mockRestore()
    dns6.mockRestore()
  }
})

it('requires origin consent for an empty MDX re-export and diagnoses its dependency', async () => {
  const { mdx, acquire, contacts, routes } = await resourceRig()
  const owner = await acquire()
  const source = `# Preview\n\nexport {} from '${entry}'\n`
  routes.set(entry, { text: 'export const = 1' })
  try {
    const diagnose = (generation: number) => mdx.compile({ ...owner, generation, source })
    expect(await diagnose(1)).toMatchObject([{ line: 3 }])
    const { pending } = await mdx.externalResources(owner)
    expect(pending).toMatchObject([
      { origin: 'https://one.example', purpose: 'mdx-dependency-diagnostics' },
    ])
    expect(contacts).toEqual([])

    await mdx.approveExternalResource({ ...owner, requestId: pending[0]!.id })
    expect(await diagnose(2)).toMatchObject([
      { line: 3, message: expect.stringMatching(/invalid javascript syntax/i) },
    ])
    expect(contacts).toEqual([entry])
    expect((await mdx.externalResources(owner)).pending).toEqual([])

    await expect(
      mdx.compile({
        ...owner,
        generation: 3,
        source: "# Preview\n\nexport {} from './missing.js'\n",
      }),
    ).resolves.toMatchObject([{ line: 3, message: expect.stringContaining('missing.js') }])
    expect(contacts).toEqual([entry])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
  }
})

it('reports consent at each original MDX declaration, including one that supplies the layout', async () => {
  const { mdx, acquire, contacts } = await resourceRig()
  const owner = await acquire()
  try {
    const source = [
      '# Preview',
      '',
      `import { feature } from '${entry}'`,
      `export { default, helper } from 'https://one.example/layout.js'`,
      `export * from 'https://one.example/widgets.js'`,
      '',
      '<div>',
      '',
      `import '${entry}'`,
      '',
      '</div>',
    ].join('\n')
    const diagnostics = await mdx.compile({ ...owner, generation: 1, source })
    expect(diagnostics).toMatchObject(
      [3, 4, 5, 9].map((line) => ({ line, message: expect.stringMatching(/consent/i) })),
    )
    expect((await mdx.externalResources(owner)).pending).toMatchObject([
      { origin: 'https://one.example' },
    ])
    expect(contacts).toEqual([])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
  }
})

it('diagnoses empty and populated import attributes before requesting consent or contacting an origin', async () => {
  const { root, mdx, acquire, contacts, routes } = await resourceRig()
  const owner = await acquire()
  const withInUrl = 'https://one.example/plain.js?note=with{}'
  routes.set(withInUrl, { text: 'export const plain = 1' })
  routes.set(entry, { text: 'export const other = 2' })
  await mdx.compile({ ...owner, generation: 1, source: `import '${entry}'\n` })
  const { pending } = await mdx.externalResources(owner)
  await mdx.approveExternalResource({ ...owner, requestId: pending[0]!.id })

  const approved = 'https://one.example/data.js?token=private-url-value'
  const unapproved = 'https://two.example/data.js'
  await writeFile(
    join(root, 'child.js'),
    [
      `import payload from '${approved}' with { type: 'json' };`,
      `export { default as metadata } from '${unapproved}' with {};`,
      `export * from '${approved}&kind=star' /* gap */ with { /* empty */ };`,
      `export {} from '${approved}&kind=empty' with {};`,
      `import '${withInUrl}' /* with {} */;`,
    ].join('\n'),
  )
  await writeFile(
    join(root, 'child.jsx'),
    [
      `import '${unapproved}?kind=side-effect' with {}`,
      `export { default as metadata } from '${approved}&kind=named' with { loader: 'private-loader-value' };`,
      `export * from '${unapproved}?kind=star' with { type: 'json' };`,
      `export * from '${entry}' // with {}`,
      'export const view = <div>{"with {}"}</div>;',
    ].join('\n'),
  )
  const diagnostics = await mdx.compile({
    ...owner,
    generation: 2,
    source: "import './child.js'\nimport './child.jsx'\n\n# Preview",
  })
  expect(diagnostics.map(({ message }) => message)).toEqual(
    ['js', 'jsx'].flatMap((format) =>
      (format === 'js' ? [1, 2, 3, 4] : [1, 2, 3]).map((line) =>
        expect.stringMatching(
          new RegExp(`child\\.${format}:${line}:1: .*unsupported import attributes`, 'i'),
        ),
      ),
    ),
  )
  expect(JSON.stringify(diagnostics)).not.toMatch(
    /https:\/\/|private-url-value|private-loader-value/,
  )
  expect((await mdx.externalResources(owner)).pending).toEqual([])
  expect(contacts).toEqual([withInUrl, entry])

  // MDX's parser may reject the syntax itself. Even if it accepts the clause,
  // neither an ordinary dependency nor a rewritten layout import may escape.
  for (const [index, declaration] of [
    `import '${approved}' with {};`,
    `export { default } from '${unapproved}' with {};`,
    `export * from '${approved}&kind=star' with {};`,
    `export {} from '${approved}&kind=empty' with {};`,
  ].entries()) {
    const invalidMdx = await mdx.compile({
      ...owner,
      generation: index + 3,
      source: `# Preview\n\n${declaration}\n`,
    })
    expect(invalidMdx).toMatchObject([{ line: 3, column: expect.any(Number) }])
    expect(JSON.stringify(invalidMdx)).not.toMatch(/https:\/\/|private-url-value/)
    expect((await mdx.externalResources(owner)).pending).toEqual([])
    expect(contacts).toEqual([withInUrl, entry])
  }
  await mdx.releaseDiagnosticsLease(owner)
})

it('accepts CommonJS spellings bound by browser ESM in JS, JSX and MDX', async () => {
  const { root, mdx, acquire, contacts } = await resourceRig()
  const owner = await acquire()
  try {
    await writeFile(
      join(root, 'local.js'),
      [
        'const exports = { value: 1 };',
        'const module = { exports };',
        'module.exports.value = require();',
        'function require() { if (exports.value) { var module = exports; } return module.value; }',
        'export const value = exports.value;',
        'export const View = () => null;',
      ].join('\n'),
    )
    await writeFile(
      join(root, 'view.jsx'),
      [
        "import * as exports from './local.js';",
        'export const view = ({ module }, require = (value) => value) =>',
        '  <exports require="module.exports"><exports.View />{require(module.exports)}{exports.value}</exports>;',
      ].join('\n'),
    )
    const source = [
      "import { value as module } from './local.js'",
      "import './view.jsx'",
      '',
      'export const exports = { value: module }',
      'export function require({ value }) { return value }',
      '',
      '# Preview',
      '',
      '<exports require={require(exports)} {...{ module }} />',
      '',
      '{exports.value + require({ value: module })}',
    ].join('\n')
    await expect(mdx.compile({ ...owner, generation: 1, source })).resolves.toEqual([])
    expect(contacts).toEqual([])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
  }
})

it('diagnoses free CommonJS references without echoing source', async () => {
  const { root, mdx, acquire, contacts } = await resourceRig()
  const owner = await acquire()
  try {
    const define = "Object.defineProperty(exports, 'private-guest-value', { value: 1 });"
    const initialize = 'export function load(loader = require) { var require = () => null; }'
    await writeFile(join(root, 'child.js'), `${define}\n${initialize}`)
    const view = 'export const view = <exports require="module"><module.View /></exports>;'
    await writeFile(join(root, 'child.jsx'), view)
    const alias = '  {...(() => { const loader = require; return { exports: 1, module: 2 } })()}'
    const destructure =
      '  require={(() => { const { privateValue } = exports; return privateValue })()}'
    const source = [
      "import './child.js'",
      "import './child.jsx'",
      '',
      '<exports',
      alias,
      destructure,
      '/>',
      '',
      `{import('${entry}')}`,
      '',
      '{import.meta.url}',
    ].join('\n')
    const diagnostics = await mdx.compile({ ...owner, generation: 1, source })
    const position = (line: string, name: string) => line.indexOf(name) + 1
    expect(diagnostics).toHaveLength(7)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        ...[
          [1, 'js', 1, position(define, 'exports')],
          [1, 'js', 2, position(initialize, 'require')],
          [2, 'jsx', 1, position(view, 'module.View')],
        ].map(([line, format, moduleLine, column]) =>
          expect.objectContaining({
            line,
            message: expect.stringMatching(`child\\.${format}:${moduleLine}:${column}: .*CommonJS`),
          }),
        ),
        ...[
          [5, position(alias, 'require')],
          [6, position(destructure, 'exports')],
        ].map(([line, column]) =>
          expect.objectContaining({ line, column, message: expect.stringMatching(/CommonJS/) }),
        ),
        expect.objectContaining({
          line: 9,
          column: 2,
          message: expect.stringMatching(/dynamic import/i),
        }),
        expect.objectContaining({
          line: 11,
          column: 2,
          message: expect.stringMatching(/import\.meta/),
        }),
      ]),
    )
    expect(JSON.stringify(diagnostics)).not.toMatch(/private-guest-value|privateValue|one\.example/)
    expect((await mdx.externalResources(owner)).pending).toEqual([])
    expect(contacts).toEqual([])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
  }
})

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
  expect(await diagnose(5)).toHaveLength(4)
  expect((await mdx.externalResources(owner)).pending).toEqual([])
  expect(contacts).not.toContain('https://two.example/lib/style.css')
  expect(contacts).not.toContain('https://two.example/lib/dynamic.js')

  await mdx.releaseDiagnosticsLease(owner)
  await mdx.releaseDiagnosticsLease(secondView)
})

it('retires requests on rejection, edits, saves, document replacement and vault reopen', async () => {
  const { caller, mdx, acquire, contacts, retireDocument, registry, root, session } =
    await resourceRig()
  let owner = await acquire()
  const pending = async (generation: number) => {
    await mdx.compile({ ...owner, generation, source: externalSource })
    return { ...owner, requestId: (await mdx.externalResources(owner)).pending[0]!.id }
  }
  const rejected = await pending(1)
  await mdx.rejectExternalResource(rejected)
  expect((await mdx.externalResources(owner)).pending).toEqual([])
  await expect(mdx.approveExternalResource(rejected)).rejects.toThrow()
  const edited = await pending(2)
  const staleApproval = expect(mdx.approveExternalResource(edited)).rejects.toThrow()
  const reading = mdx.externalResources(owner)
  await mdx.cancelCompile({ ...owner, generation: 2 })
  expect(await reading).toMatchObject({ approved: [], pending: [] })
  await staleApproval
  await pending(2)
  await expect(mdx.approveExternalResource(edited)).rejects.toThrow()
  const saved = await pending(3)
  await caller.notes.write({ remote: REMOTE, path: 'page.mdx', text: '# saved independently' })
  await expect(mdx.approveExternalResource(saved)).rejects.toThrow()
  owner = await acquire()
  const previousDocument = await pending(1)
  retireDocument()
  await expect(mdx.approveExternalResource(previousDocument)).rejects.toThrow()
  owner = await acquire()
  const previousOpen = await pending(1)
  const otherRemote = 'syv-ai/other'
  await registry.add({ remote: otherRemote, path: root, name: 'other', lastOpenedAt: '2026-01-01' })
  await caller.vaults.open({ remote: otherRemote })
  await caller.vaults.open({ remote: REMOTE })
  await expect(mdx.approveExternalResource(previousOpen)).rejects.toThrow()
  owner = await acquire()
  const previousAccount = await pending(1)
  await session.signOut()
  await expect(mdx.approveExternalResource(previousAccount)).rejects.toThrow()
  await expect(mdx.externalResources(owner)).rejects.toThrow()
  expect(contacts).toEqual([])
})

it('allows Retry after prevention or abort but retires leases when a new document or error page commits', async () => {
  const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: () => {} })
  const document = contents as unknown as WebContents
  const appUrl = 'file:///holi/index.html'
  guardNavigation({ webContents: document } as BrowserWindow, appUrl, () => {}, new Set())
  const { caller, root } = await rig({ document, signedIn: auth(42, 'alice') })
  const mdx = caller.mdxTrust
  const start = (url: string) =>
    contents.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
  const commit = () => contents.emit('did-navigate', {}, appUrl, -1, '')
  start(appUrl)
  await expect(mdx.status({ remote: REMOTE })).rejects.toThrow()
  commit()
  await writeFile(join(root, 'page.mdx'), '# source')
  const { context } = await mdx.status({ remote: REMOTE })
  await mdx.approve({ remote: REMOTE, context: context! })
  const acquire = (context: string) =>
    mdx.acquireDiagnosticsLease({ remote: REMOTE, path: 'page.mdx', context })
  const trusted = (await mdx.status({ remote: REMOTE })).context!
  const compile = (owner: { lease: string }) =>
    mdx.compile({ ...owner, generation: 1, source: '# source' })
  const initial = await acquire(trusted)

  const away = 'file:///dropped.txt'
  start(away)
  let prevented = false
  contents.emit('will-navigate', { url: away, preventDefault: () => (prevented = true) }, away)
  expect(prevented).toBe(true)
  // Electron does not emit did-navigate for the cancelled attempt.
  await expect(compile(initial)).rejects.toThrow()
  const retried = await acquire(trusted)
  await expect(compile(retried)).resolves.toHaveLength(1)

  // A programmatic reload has no cancellable will-navigate. Model a retry from
  // the still-committed document before Chromium commits the replacement.
  start(appUrl)
  await expect(compile(retried)).rejects.toThrow()
  const provisional = await acquire(trusted)
  commit()
  await expect(compile(provisional)).rejects.toThrow()
  await expect(acquire(trusted)).rejects.toThrow()
  const replacementContext = (await mdx.status({ remote: REMOTE })).context!
  const replacement = await acquire(replacementContext)
  await expect(compile(replacement)).resolves.toHaveLength(1)

  const missing = 'file:///holi/missing.html'
  start(missing)
  await expect(compile(replacement)).rejects.toThrow()
  // A loadURL rejected with ERR_ABORTED without commit only stops loading.
  contents.emit('did-stop-loading')
  const stillCommitted = await acquire(replacementContext)
  await expect(compile(stillCommitted)).resolves.toHaveLength(1)

  start(missing)
  const beforeErrorCommit = await acquire(replacementContext)
  contents.emit('did-fail-provisional-load', {}, -6, 'ERR_FILE_NOT_FOUND', missing, false, 1, 2)
  await expect(compile(beforeErrorCommit)).resolves.toHaveLength(1)
  contents.emit('did-fail-provisional-load', {}, -6, 'ERR_FILE_NOT_FOUND', missing, true, 1, 1)
  await expect(compile(beforeErrorCommit)).rejects.toThrow()
  await expect(acquire(replacementContext)).rejects.toThrow()
  await expect(mdx.status({ remote: REMOTE })).rejects.toThrow()

  start(appUrl)
  commit()
  const recovered = await acquire((await mdx.status({ remote: REMOTE })).context!)
  await expect(compile(recovered)).resolves.toHaveLength(1)
  await mdx.releaseDiagnosticsLease(recovered)
})

it('persists concurrently approved distinct origins from two splits on the same source', async () => {
  const { mdx, acquire, routes } = await resourceRig()
  const one = await acquire()
  const two = await acquire()
  const secondEntry = 'https://two.example/lib.js'
  const source = `${externalSource}import '${secondEntry}'\n`
  routes.set(`${entry}?opaque=value`, { text: 'export const x = 1' })
  routes.set(secondEntry, { text: 'export const y = 2' })
  const compile = (owner: { lease: string }, generation: number) =>
    mdx.compile({ ...owner, generation, source })
  await compile(one, 1)
  await compile(two, 1)
  const approve = async (owner: { lease: string }, origin: string) => {
    const { pending } = await mdx.externalResources(owner)
    return { ...owner, requestId: pending.find((request) => request.origin === origin)!.id }
  }
  const first = await approve(one, 'https://one.example')
  const second = await approve(two, 'https://two.example')
  await expect(
    Promise.all([mdx.approveExternalResource(first), mdx.approveExternalResource(second)]),
  ).resolves.toEqual([{ ok: true }, { ok: true }])
  await expect(compile(one, 2)).resolves.toEqual([])
  expect(await mdx.externalResources(two)).toMatchObject({
    pending: [],
    approved: [{ origin: 'https://one.example' }, { origin: 'https://two.example' }],
  })
  await mdx.releaseDiagnosticsLease(one)
  await mdx.releaseDiagnosticsLease(two)
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

it('publishes the first grant read across compile startup and can revoke while inspection is held', async () => {
  const inspecting = gate()
  const { mdx, acquire, root, consentFile } = await resourceRig(true, {
    holdInspection: (signal) => {
      signal.throwIfAborted()
      const held = new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      inspecting.resolve()
      return held
    },
  })
  const scope = {
    root: await realpath(root),
    remote: REMOTE,
    accountId: '42',
    origin: new URL(entry).origin,
  }
  await createMdxConsentStore(consentFile).grant(scope)
  const owner = await acquire()
  // Start both routes in the same turn: the first grant read must await real
  // filesystem I/O while compile retires the source, before native inspection.
  const reading = mdx.externalResources(owner)
  const compiling = mdx.compile({ ...owner, generation: 1, source: externalSource }).then(
    () => 'completed',
    () => 'cancelled',
  )
  try {
    const [{ approved, pending }] = await Promise.all([
      within(reading, 3_000, 'read the first grant list'),
      within(inspecting.promise, 3_000, 'hold the inspection response'),
    ])
    expect(pending).toEqual([])
    expect(approved).toMatchObject([{ origin: scope.origin }])
    await expect(
      mdx.revokeExternalResource({ ...owner, grantId: approved[0]!.id }),
    ).resolves.toEqual({ ok: true })
    await expect(within(compiling, 2_000, 'cancel inspection on revoke')).resolves.toBe('cancelled')
    expect(await createMdxConsentStore(consentFile).allows(scope)).toBe(false)
    expect((await mdx.externalResources(owner)).approved).toEqual([])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
    await compiling
  }
})

it('closes a streaming HTTPS response on revoke and retains the same blocked grant for a save retry', async () => {
  const { mdx, acquire, consentFile, root } = await resourceRig(true)
  const network = await createMdxExternalNetworkFixture()
  const owner = await acquire()
  const other = await acquire()
  const compile = (generation: number) =>
    mdx.compile({ ...owner, generation, source: externalSource })
  const scope = {
    root: await realpath(root),
    remote: REMOTE,
    accountId: '42',
    origin: new URL(entry).origin,
  }
  try {
    await compile(1)
    const approval = async () => ({
      ...owner,
      requestId: (await mdx.externalResources(owner)).pending[0]!.id,
    })
    const failedSave = await approval()
    await mkdir(consentFile) // A real filesystem failure, even if tests are run as root.
    await expect(mdx.approveExternalResource(failedSave)).rejects.toThrow()
    await rm(consentFile, { recursive: true })
    await compile(2)
    expect(network.dials).toEqual([])
    expect((await mdx.externalResources(owner)).approved).toEqual([])
    await mdx.approveExternalResource(await approval())

    const grant = (await mdx.externalResources(other)).approved[0]!
    const receiving = gate()
    const closed = gate()
    network.routes.respond = (req, res) => {
      req.socket.once('close', () => closed.resolve())
      res.write('export const partial = ', () => receiving.resolve())
    }
    const compiling = expect(compile(3)).rejects.toThrow()
    await within(receiving.promise, 3_000, 'receive first HTTPS chunk')
    // Make the store unreadable during revocation; the old grant remains on disk.
    const backup = `${consentFile}.backup`
    await rename(consentFile, backup)
    await mkdir(consentFile)
    const revoke = { ...other, grantId: grant.id }
    await Promise.all([
      expect(mdx.revokeExternalResource(revoke)).rejects.toThrow(/revocation could not be saved/),
      // An eventual transport timeout is not evidence of revocation-driven cancellation.
      within(closed.promise, 2_000, 'disconnect revoked HTTPS response'),
      compiling,
    ])
    const blocked = { ...grant, revocationPending: true }
    expect((await mdx.externalResources(other)).approved).toEqual([blocked])
    await rm(consentFile, { recursive: true })
    await rename(backup, consentFile)
    expect(await createMdxConsentStore(consentFile).allows(scope)).toBe(true)
    await compile(4)
    expect(await mdx.externalResources(other)).toMatchObject({ approved: [blocked] })
    expect((await mdx.externalResources(owner)).pending).toEqual([])
    await expect(mdx.revokeExternalResource(revoke)).resolves.toEqual({ ok: true })
    expect(await createMdxConsentStore(consentFile).allows(scope)).toBe(false)
    await compile(5)
    expect(await mdx.externalResources(owner)).toMatchObject({
      approved: [],
      pending: [{ origin: grant.origin }],
    })
    expect(network.requests.map(({ url }) => url)).toEqual(['/entry.js?opaque=value'])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
    await mdx.releaseDiagnosticsLease(other)
    await network.close()
  }
})

it('drains a revocation accepted before document retirement and denies new admissions on shutdown', async () => {
  let onChange = () => {}
  const { mdx, acquire, root, consentFile, shutdown } = await resourceRig(false, {
    onResourceChange: () => onChange(),
  })
  const owner = await acquire()
  await mdx.compile({ ...owner, generation: 1, source: externalSource })
  const requestId = (await mdx.externalResources(owner)).pending[0]!.id
  await mdx.approveExternalResource({ ...owner, requestId })
  const grant = (await mdx.externalResources(owner)).approved[0]!
  const scope = {
    root: await realpath(root),
    remote: REMOTE,
    accountId: '42',
    origin: grant.origin,
  }
  const accepted = gate<boolean>()
  // Close admission synchronously on the revocation's invalidation push, before its write can start.
  onChange = () =>
    accepted.resolve(
      shutdown(async () => {
        expect(await createMdxConsentStore(consentFile).allows(scope)).toBe(false)
        return true
      }),
    )
  const revoke = { ...owner, grantId: grant.id }
  const revoked = expect(mdx.revokeExternalResource(revoke)).resolves.toEqual({ ok: true })
  await expect(
    within(accepted.promise, 3_000, 'drain accepted revocation on shutdown'),
  ).resolves.toBe(true)
  await expect(mdx.status({ remote: REMOTE })).rejects.toThrow()
  await expect(mdx.revokeExternalResource(revoke)).rejects.toThrow()
  await revoked
  await mdx.releaseDiagnosticsLease(owner)
})

it('retires drained grant IDs in every split when a failed buffer flush vetoes quit', async () => {
  const { mdx, acquire, root, consentFile, shutdown, contacts, routes } = await resourceRig()
  const owner = await acquire()
  const other = await acquire()
  const observing = await acquire()
  const url = `${entry}?opaque=value`
  routes.set(url, { text: 'export const value = true' })
  const scope = {
    root: await realpath(root),
    remote: REMOTE,
    accountId: '42',
    origin: new URL(entry).origin,
  }
  const stored = () => createMdxConsentStore(consentFile).allows(scope)
  const approve = async (split: { lease: string }, generation: number) => {
    await mdx.compile({ ...split, generation, source: externalSource })
    const { pending } = await mdx.externalResources(split)
    await mdx.approveExternalResource({ ...split, requestId: pending[0]!.id })
  }
  try {
    await approve(owner, 1)
    const grant = (await mdx.externalResources(owner)).approved[0]!
    const observed = (await mdx.externalResources(observing)).approved[0]!
    const revoke = { ...owner, grantId: grant.id }
    const backup = `${consentFile}.backup`
    await rename(consentFile, backup)
    await mkdir(consentFile)
    await expect(mdx.revokeExternalResource(revoke)).rejects.toThrow()
    await expect(mdx.externalResources(owner)).resolves.toMatchObject({
      approved: [{ ...grant, revocationPending: true }],
    })
    await rm(consentFile, { recursive: true })
    await rename(backup, consentFile)
    expect(await stored()).toBe(true)

    const renderer = new EventEmitter()
    await expect(
      shutdown(async () => {
        expect(await stored()).toBe(false)
        await expect(mdx.status({ remote: REMOTE })).rejects.toThrow()
        const result = await requestFlush({
          send: (id) => renderer.emit('done', id, 'write failed'),
          onDone(done) {
            renderer.on('done', done)
            return () => renderer.off('done', done)
          },
        })
        return result === 'flushed'
      }),
    ).resolves.toBe(false)

    await approve(other, 1)
    // Don't refresh either split before trying its old ID: the views can still
    // hold IDs issued before the quit attempt.
    await expect(mdx.revokeExternalResource(revoke)).rejects.toThrow()
    await expect(
      mdx.revokeExternalResource({ ...observing, grantId: observed.id }),
    ).rejects.toThrow()
    expect(await stored()).toBe(true)
    await expect(mdx.compile({ ...owner, generation: 2, source: externalSource })).resolves.toEqual(
      [],
    )
    expect(contacts).toContain(url)

    const { approved } = await mdx.externalResources(owner)
    expect(approved).toMatchObject([{ origin: scope.origin }])
    expect(approved[0]!.id).not.toBe(revoke.grantId)
    await expect(
      mdx.revokeExternalResource({ ...owner, grantId: approved[0]!.id }),
    ).resolves.toEqual({ ok: true })
    expect(await stored()).toBe(false)
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
    await mdx.releaseDiagnosticsLease(other)
    await mdx.releaseDiagnosticsLease(observing)
  }
})

it('retries an unsaved revocation on quit even after sign-out and vault removal', async () => {
  const { caller, mdx, acquire, root, consentFile, shutdown } = await resourceRig()
  const owner = await acquire()
  try {
    await mdx.compile({ ...owner, generation: 1, source: externalSource })
    const requestId = (await mdx.externalResources(owner)).pending[0]!.id
    await mdx.approveExternalResource({ ...owner, requestId })
    const grant = (await mdx.externalResources(owner)).approved[0]!
    const backup = `${consentFile}.backup`
    await rename(consentFile, backup)
    await mkdir(consentFile)
    const revoke = { ...owner, grantId: grant.id }
    await expect(mdx.revokeExternalResource(revoke)).rejects.toThrow()

    const scope = {
      root: await realpath(root),
      remote: REMOTE,
      accountId: '42',
      origin: grant.origin,
    }
    const stored = () => createMdxConsentStore(consentFile).allows(scope)
    const quit = vi.fn(async () => {
      expect(await stored()).toBe(false)
      return true
    })
    const reportBlocked = vi.fn(async () => {})
    await expect(shutdown(quit, reportBlocked)).resolves.toBe(false)
    expect(reportBlocked).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
    // The failed quit restored admission, but the grant stayed blocked.
    await expect(mdx.externalResources(owner)).resolves.toMatchObject({
      approved: [{ ...grant, revocationPending: true }],
    })

    await caller.auth.signOut()
    await caller.vaults.remove({ remote: REMOTE })
    await expect(mdx.revokeExternalResource(revoke)).rejects.toThrow()
    await rm(consentFile, { recursive: true })
    await rename(backup, consentFile)
    expect(await stored()).toBe(true)

    await expect(shutdown(quit, reportBlocked)).resolves.toBe(true)
    expect(quit).toHaveBeenCalledOnce()
    expect(reportBlocked).toHaveBeenCalledOnce()
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
  }
})

it.each(['local', 'external'] as const)(
  'anchors dependency diagnostics at the parent declaration for %s modules',
  async (kind) => {
    const { mdx, acquire, root, routes } = await resourceRig()
    const syntax = 'export const invalid = ;'
    if (kind === 'local') await writeFile(join(root, 'broken.js'), syntax)
    else routes.set(entry, { text: syntax })
    const owner = await acquire()
    const prefix = 'export const beforeDeclaration = true; '
    const source = `${prefix}import '${kind === 'local' ? './broken.js' : entry}'\n`
    const parentColumn = prefix.length + 1
    try {
      let diagnostics = await mdx.compile({ ...owner, generation: 1, source })
      if (kind === 'external') {
        expect(diagnostics[0]).toMatchObject({ line: 1, column: parentColumn })
        const requestId = (await mdx.externalResources(owner)).pending[0]!.id
        await mdx.approveExternalResource({ ...owner, requestId })
        diagnostics = await mdx.compile({ ...owner, generation: 2, source })
      }
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatchObject({ line: 1, column: parentColumn })
      expect(diagnostics[0]!.message).toContain(`:1:${syntax.indexOf(';') + 1}:`)
    } finally {
      await mdx.releaseDiagnosticsLease(owner)
    }
  },
)
