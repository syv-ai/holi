/**
 * The Google draft CLI as the agent reaches it: argv parsing, the registered
 * capability, and the Gmail HTTP request, all over a disposable fake account.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyVaultSnapshot } from '@holi/shared'
import { resolveArgv } from '../../../main/bridge/cli'
import {
  createCapabilityRegistry,
  type CapabilityContext,
} from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import type { GoogleAccountsManager } from '../main/accounts'
import { googleCapabilities, GOOGLE_NAMESPACES } from '../main/capabilities'

afterEach(() => vi.unstubAllGlobals())

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const context = (
  remote: string,
  root = '/unused',
  files: { path: string; updatedAt: string }[] = [],
): CapabilityContext => ({
  remote,
  root,
  bundle: null,
  snapshot: async () => ({ ...emptyVaultSnapshot(), files }),
  claims: async () => [],
  core: noCoreServices(),
})

function rig() {
  const calls: { remote: string; url: string; method: string; body?: unknown }[] = []
  const accounts = {
    sessionFor: async (remote: string) => ({
      getAccessToken: async () => `token:${remote}`,
    }),
  } as unknown as GoogleAccountsManager
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const remote = String(new Headers(init?.headers).get('Authorization')).slice(7)
      const method = init?.method ?? 'GET'
      const url = String(input)
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ remote, url, method, ...(body === undefined ? {} : { body }) })
      const response = url.includes('/threads/')
        ? {
            messages: [
              {
                id: 'old',
                payload: { headers: [{ name: 'Message-ID', value: '<old@example.test>' }] },
              },
              {
                id: 'draft',
                labelIds: ['DRAFT'],
                payload: { headers: [{ name: 'Message-ID', value: '<draft@example.test>' }] },
              },
              {
                id: 'latest',
                payload: {
                  headers: [
                    { name: 'Message-ID', value: ' (latest) <"id with space"@-example> (tail)' },
                    {
                      name: 'References',
                      value:
                        '(first) <first@example.test><second@example.test>\r\n \t<prior@example.test>',
                    },
                  ],
                },
              },
            ],
          }
        : { id: url.includes('/drafts/') ? 'draft id/1' : 'new-draft' }
      return new Response(JSON.stringify(response), { status: 200 })
    }),
  )
  const registry = createCapabilityRegistry()
  registry.register(
    GOOGLE_NAMESPACES,
    googleCapabilities({
      accounts,
      dataFor: async () => null,
      settings: { read: async () => ({ calendars: {}, imageSenders: [] }), write: async () => {} },
    }),
  )
  const run = async (
    remote: string,
    argv: string[],
    stdin: string | null = null,
    root = '/unused',
    files: { path: string; updatedAt: string }[] = [],
  ) => {
    const request = resolveArgv(['google', ...argv], registry.commands(), stdin)
    if (request.kind !== 'run') throw new Error(`expected run, got ${request.kind}`)
    return registry.run(request.name, 'cli', context(remote, root, files), request.params)
  }
  return { calls, run }
}

function rawMessage(call: { body?: unknown }): string {
  const body = call.body as { message: { raw: string } }
  return Buffer.from(body.message.raw, 'base64url').toString('utf8')
}

function messageBody(message: string): string {
  const encoded = message.split('\r\n\r\n').at(-1)
  return Buffer.from(encoded?.trim() ?? '', 'base64').toString('utf8')
}

describe('google draft CLI', () => {
  it('parses repeated and comma-separated cc/bcc and preserves the body from stdin', async () => {
    const { calls, run } = rig()
    await run(
      'vault/one',
      [
        'draft',
        '--to',
        'to@example.test',
        '--subject',
        'Hello',
        '--cc',
        'one@example.test,two@example.test',
        '--cc',
        'three@example.test',
        '--bcc',
        'hidden@example.test,also-hidden@example.test',
        '--bcc',
        'last@example.test',
      ],
      'body from stdin\n',
    )
    expect(calls).toHaveLength(1)
    const message = rawMessage(calls[0]!)
    expect(message).toContain('Cc: one@example.test, two@example.test, three@example.test')
    expect(message).toContain(
      'Bcc: hidden@example.test, also-hidden@example.test, last@example.test',
    )
    expect(messageBody(message)).toBe('body from stdin\n')
  })

  it('threads the draft to the latest non-draft message with legal CFWS and adjacent/folded references', async () => {
    const { calls, run } = rig()
    await run(
      'vault/one',
      ['draft', '--to', 'to@example.test', '--subject', 'Re', '--thread', 'thread/1'],
      'reply',
    )
    expect(calls.map(({ method, url }) => [method, url])).toEqual([
      ['GET', `${BASE}/threads/thread%2F1?format=full`],
      ['POST', `${BASE}/drafts`],
    ])
    const message = rawMessage(calls[1]!)
    expect(message).toContain('In-Reply-To: <"id with space"@-example>')
    expect(message).toContain(
      'References: <first@example.test> <second@example.test> <prior@example.test> <"id with space"@-example>',
    )
  })

  it('includes a disposable vault attachment in the draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-google-draft-'))
    try {
      await writeFile(join(root, 'attachment.txt'), 'fixture attachment bytes')
      const { calls, run } = rig()
      await run(
        'vault/one',
        ['draft', '--to', 'to@example.test', '--subject', 'Attached', '--attach', 'attachment.txt'],
        'body',
        root,
        [{ path: 'attachment.txt', updatedAt: '' }],
      )
      const message = rawMessage(calls[0]!)
      expect(message).toContain('filename="attachment.txt"')
      expect(message).toContain(Buffer.from('fixture attachment bytes').toString('base64'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('updates exactly one encoded draft via PUT while retaining its draft id', async () => {
    const { calls, run } = rig()
    await run(
      'vault/one',
      ['draft', '--update', 'draft id/1', '--to', 'to@example.test', '--subject', 'Changed'],
      'replacement',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: `${BASE}/drafts/draft%20id%2F1`,
      body: { id: 'draft id/1' },
    })
    expect(calls.some(({ method, url }) => method === 'POST' || url.endsWith('/send'))).toBe(false)
    expect(messageBody(rawMessage(calls[0]!))).toBe('replacement')
  })

  it('does not fall back to creating a draft if an update target is missing', async () => {
    const { calls, run } = rig()
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404 }),
    )
    vi.stubGlobal('fetch', fetch)
    await expect(
      run(
        'vault/one',
        ['draft', '--update', 'gone', '--to', 'to@example.test', '--subject', 'x'],
        'x',
      ),
    ).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
  })

  it('uses the account selected for the calling vault', async () => {
    const { calls, run } = rig()
    await run('owner/one', ['draft', '--to', 'one@example.test', '--subject', 'one'], 'one')
    await run('owner/two', ['draft', '--to', 'two@example.test', '--subject', 'two'], 'two')
    expect(calls.map(({ remote }) => remote)).toEqual(['token:owner/one', 'token:owner/two'])
  })

  it('rejects direct-send Bcc before network access and rejects extra fields with --draft', async () => {
    const { calls, run } = rig()
    await expect(
      run(
        'vault/one',
        ['send', '--to', 'to@example.test', '--subject', 'x', '--bcc', 'hidden@example.test'],
        'body',
      ),
    ).rejects.toThrow(/bcc/i)
    await expect(
      run('vault/one', ['send', '--draft', 'existing', '--to', 'other@example.test']),
    ).rejects.toThrow(/alternatives/i)
    expect(calls).toEqual([])
  })
})
