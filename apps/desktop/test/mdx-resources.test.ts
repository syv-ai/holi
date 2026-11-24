import { Resolver } from 'node:dns/promises'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createMdxConsentStore } from '../src/main/mdx-consent'
import { createMdxDiagnostics } from '../src/main/mdx-diagnostics'
import { fetchMdxExternalData } from '../src/main/mdx-external-data'
import { createMdxResources, type MdxInspectResult } from '../src/main/mdx-resources'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const noop = () => {}
  class CompilerSession extends EventEmitter {
    webRequest = { onBeforeRequest: noop, onHeadersReceived: noop }
    protocol = { handle: noop, unhandle: noop }
    async clearStorageData() {}
    async clearCache() {}
    setPermissionRequestHandler = noop
    setPermissionCheckHandler = noop
    setDisplayMediaRequestHandler = noop
  }

  // Replace native window loading, not the request/result protocol or the parser.
  // Session isolation and bootstrap request policy are covered in mdx-compiler.test.ts.
  const guest = globalThis as typeof globalThis & {
    __holiMdxReceive(encoded: string): void
    __holiMdxTakeResult(): (MdxInspectResult & { id: string }) | null
  }
  let nextId = 0
  class CompilerWindow extends EventEmitter {
    loaded = false
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      id: ++nextId,
      setWindowOpenHandler: noop,
      executeJavaScript: async (script: string) => {
        if (!this.loaded || this.destroyed) throw new Error('Compiler guest is not live')
        const encoded = /^window\.__holiMdxReceive\('([A-Za-z0-9+/=]+)'\)$/.exec(script)?.[1]
        if (encoded) return guest.__holiMdxReceive(encoded)
        if (script === 'window.__holiMdxTakeResult()')
          return structuredClone(guest.__holiMdxTakeResult())
        throw new Error('Unexpected compiler guest message')
      },
    })
    async loadURL(url: string) {
      if (url !== 'https://mdx-compiler.invalid/guest.html')
        throw new Error('Unexpected compiler guest URL')
      await import('../src/mdx-compiler/guest')
      this.loaded = true
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
  }
  return {
    BrowserWindow: CompilerWindow,
    session: { fromPartition: () => new CompilerSession() },
    webContents: { fromId: () => undefined },
  }
})

it('keeps valid long import URLs and diagnoses oversized URLs without dropping other edges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'holi-mdx-resources-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const root = await realpath(dir)
  const path = 'page.mdx'
  // The window adapter loads the real guest module directly, but main still checks its assets.
  await Promise.all([
    writeFile(join(root, 'guest.html'), '<html></html>'),
    writeFile(join(root, 'guest.js'), ''),
    writeFile(join(root, path), '# Page'),
  ])
  // Keep the production consent and URL checks but never reach a real DNS resolver.
  const dns4 = vi.spyOn(Resolver.prototype, 'resolve4').mockRejectedValue({ code: 'ENODATA' })
  const dns6 = vi.spyOn(Resolver.prototype, 'resolve6').mockRejectedValue({ code: 'ENODATA' })
  onTestFinished(() => {
    dns4.mockRestore()
    dns6.mockRestore()
  })
  const fetch = vi.fn(fetchMdxExternalData)
  const compiler = createMdxResources(root)
  onTestFinished(() => compiler.close())
  const remote = 'owner/notes'
  const broker = createMdxDiagnostics({
    authorize: () => true,
    context: () => ({ accountGeneration: 1, accountId: '42', remote, openRevision: 1, active: {} }),
    root: async () => root,
    trusted: async () => true,
    external: { consent: createMdxConsentStore(join(root, 'consent.json')), fetch },
    createResourceOwner: compiler.createOwner,
    retireResourceOwner: compiler.retireOwner,
    inspect: compiler.inspect,
  })
  onTestFinished(() => broker.close())
  const lease = await broker.acquire({ remote, path, context: 'active-document' })
  const privateMarker = 'PRIVATE_QUERY_MARKER'
  const query = `opaque=${privateMarker}`
  const atLength = (origin: string, length: number) => {
    const prefix = `https://${origin}/entry.js?${query}`
    return prefix + 'x'.repeat(length - prefix.length)
  }
  const long = atLength('long.example', 4096)
  const overRaw = atLength('raw-limit.example', 4097)
  const overCanonical = `https://canonical-limit.example/entry.js?${query}${'é'.repeat(700)}`
  const other = 'https://other.example/entry.js'
  const source = [
    `import '${overRaw}'`,
    `import '${overCanonical}'`,
    `export { kept } from '${long}'`,
    `import '${other}'`,
    "import 'some-package'",
  ].join('\n')

  const diagnostics = await broker.compile({ ...lease, generation: 1, source })
  expect(diagnostics).toHaveLength(5)
  for (const [line, message] of [
    [1, /length limit/i],
    [2, /unsupported/i],
    [3, /consent/i],
    [4, /consent/i],
    [5, /unsupported/i],
  ] as const) {
    expect(diagnostics).toContainEqual({ line, column: 1, message: expect.stringMatching(message) })
  }
  const { pending } = await broker.externalResources(lease)
  expect(pending.map((request) => request.origin).sort()).toEqual([
    'https://long.example',
    'https://other.example',
  ])
  expect(fetch.mock.calls.map(([request]) => request.url).sort()).toEqual([long, other])
  expect(JSON.stringify({ diagnostics, pending })).not.toContain(privateMarker)
  expect(dns4).not.toHaveBeenCalled()
  expect(dns6).not.toHaveBeenCalled()
})
