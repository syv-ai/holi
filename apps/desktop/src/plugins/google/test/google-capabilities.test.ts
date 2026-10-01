/**
 * Google's capabilities at the UI door: the composer's payload and the
 * accounts a vault uses.
 *
 * The UI door is where the renderer's payload stops being trusted, so most of
 * the composer cases are about a bad shape being refused rather than reaching
 * `buildRfc822` as something that looks like a header. No network: these are
 * about the seam, not about Gmail.
 */
import { describe, expect, it } from 'vitest'
import { emptyVaultSnapshot } from '@holi/shared'
import type { CapabilityError } from '../../../main/capabilities/error'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import type { GoogleAccountsManager } from '../main/accounts'
import { GoogleApiError } from '../main/api'
import { googleCapabilities, GOOGLE_NAMESPACES } from '../main/capabilities'
import type { GoogleData } from '../main/data'

const MAIL = { to: ['bo@example.com'], subject: 'Q2 budget', body: 'Here it is.' }

interface RigOptions {
  data?: Partial<GoogleData> | null
  accounts?: Partial<GoogleAccountsManager>
}

/** The capabilities over a fake data layer and accounts manager, recording
 *  what each call asked of them, run through the UI door for `remote`. */
function rig({ data = {}, accounts = {} }: RigOptions = {}) {
  const calls: { name: string; input: unknown }[] = []
  const record =
    <T>(name: string, result: T) =>
    async (input: unknown): Promise<T> => {
      calls.push({ name, input })
      return result
    }
  const googleData =
    data === null
      ? null
      : ({
          sendMail: record('sendMail', { id: 'm-1' }),
          saveDraft: record('saveDraft', { id: 'd-1' }),
          discardDraft: record('discardDraft', undefined),
          sendAs: async () => ['ada@syv.ai'],
          ...data,
        } as GoogleData)
  const registry = createCapabilityRegistry()
  registry.register(
    GOOGLE_NAMESPACES,
    googleCapabilities({
      accounts: accounts as GoogleAccountsManager,
      dataFor: async () => googleData,
      calendarPrefs: { read: async () => ({}), set: async () => {} },
      imagePrefs: { read: async () => [], allow: async () => {}, clear: async () => {} },
    }),
  )
  const call = async (name: string, params?: unknown, remote = 'owner/repo') =>
    (
      await registry.run(
        `google.${name}`,
        'ui',
        {
          remote,
          root: '',
          bundle: null,
          snapshot: async () => emptyVaultSnapshot(),
          core: noCoreServices(),
        },
        params,
      )
    ).value
  return { call, calls }
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: CapabilityError) => ({ code: e.code, message: e.message }),
  )

describe('the composer', () => {
  it('send passes the mail straight through to the write surface', async () => {
    const { call, calls } = rig()
    expect(await call('send', { mail: MAIL, threadId: 't1' })).toEqual({ id: 'm-1' })
    expect(calls).toEqual([{ name: 'sendMail', input: { threadId: 't1', mail: { ...MAIL } } }])
  })

  it('send carries the html the renderer previewed', async () => {
    // The renderer previewed those exact bytes and main sends them, so the
    // preview is the artifact rather than a likeness.
    const { call, calls } = rig()
    await call('send', { mail: { ...MAIL, html: '<p>Here it is.</p>' } })
    expect((calls[0]!.input as { mail: { html: string } }).mail.html).toBe('<p>Here it is.</p>')
  })

  it('saveDraft returns the draft id the composer needs to update in place', async () => {
    expect(await rig().call('saveDraft', { mail: MAIL })).toEqual({ id: 'd-1' })
  })

  it('discardDraft carries the thread so the cached chip can go', async () => {
    const { call, calls } = rig()
    await call('discardDraft', { draftId: 'd-1', threadId: 't1' })
    expect(calls[0]).toEqual({ name: 'discardDraft', input: { draftId: 'd-1', threadId: 't1' } })
  })

  it('sendAs comes back from the cached account data', async () => {
    expect(await rig().call('sendAs')).toEqual(['ada@syv.ai'])
  })

  it('refuses a mail that is not an object', async () => {
    expect(await refusal(rig().call('send', { mail: 'hello' }))).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/mail/i),
    })
  })

  it('refuses recipients that are not strings', async () => {
    expect(
      await refusal(rig().call('send', { mail: { ...MAIL, to: [{ email: 'x' }] } })),
    ).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/to/i) })
  })

  it('refuses a missing subject rather than sending an undefined one', async () => {
    expect(await refusal(rig().call('send', { mail: { to: ['a@b.c'], body: 'x' } }))).toMatchObject(
      { code: 'BAD_REQUEST', message: expect.stringMatching(/subject/i) },
    )
  })

  it('drops an empty cc rather than sending an empty header', async () => {
    const { call, calls } = rig()
    await call('send', { mail: { ...MAIL, cc: [] } })
    expect((calls[0]!.input as { mail: Record<string, unknown> }).mail).not.toHaveProperty('cc')
  })

  it("maps Google's refusal onto a code rather than prose", async () => {
    // The renderer decides between Reconnect and Retry on the code.
    const { call } = rig({
      data: {
        sendMail: async () => {
          throw new GoogleApiError('scope', 403, 'this Google permission was not granted')
        },
      },
    })
    expect(await refusal(call('send', { mail: MAIL }))).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses to send at all when the vault has no account', async () => {
    // A write cannot fall back to Google directly: succeeding at Google while
    // the list on screen says otherwise is worse than saying no.
    expect(await refusal(rig({ data: null }).call('send', { mail: MAIL }))).toMatchObject({
      code: 'UNAVAILABLE',
    })
  })

  it('passes forwardOf through, so main can fetch the bytes', async () => {
    const { call, calls } = rig()
    await call('send', {
      mail: { to: ['bo@example.com'], subject: 'Fwd: Q2', body: 'x' },
      forwardOf: { messageId: 'src-1' },
    })
    expect(calls[0]!.input).toMatchObject({ forwardOf: { messageId: 'src-1' } })
  })

  it('refuses a forwardOf without a message id', async () => {
    expect(
      await refusal(
        rig().call('send', {
          mail: { to: ['bo@example.com'], subject: 'x', body: 'y' },
          forwardOf: {},
        }),
      ),
    ).toMatchObject({ message: expect.stringMatching(/messageId/i) })
  })
})

/**
 * A vault's Google account is its own: which vault a call acts on, and how
 * much each disconnect takes down with it.
 */
describe('accounts per vault', () => {
  function accountsRig() {
    const links = new Map<string, string>([['syv/work', 'sub-2']])
    const calls: { name: string; arg: unknown }[] = []
    const accounts = {
      list: () => [
        { sub: 'sub-1', email: 'ada@syv.ai' },
        { sub: 'sub-2', email: 'work@syv.ai' },
      ],
      sessionFor: async (r: string) => {
        const sub = links.get(r)
        return sub === undefined
          ? null
          : ({
              accountSub: sub,
              account: { email: 'x@syv.ai' },
              missingScopes: () => [],
            } as never)
      },
      link: async (r: string, sub: string) => {
        calls.push({ name: 'link', arg: { r, sub } })
        links.set(r, sub)
      },
      unlinkVault: async (r: string) => {
        calls.push({ name: 'unlinkVault', arg: r })
        links.delete(r)
      },
      removeAccount: async (sub: string) => {
        calls.push({ name: 'removeAccount', arg: sub })
        for (const [k, v] of links) if (v === sub) links.delete(k)
      },
    }
    return { call: rig({ accounts }).call, calls, links }
  }

  it('lists every connected account and names the one this vault uses', async () => {
    expect(await accountsRig().call('accounts', undefined, 'syv/work')).toEqual({
      accounts: [
        { sub: 'sub-1', email: 'ada@syv.ai' },
        { sub: 'sub-2', email: 'work@syv.ai' },
      ],
      current: 'sub-2',
    })
  })

  it('reports no account for a vault that has never connected', async () => {
    const { call } = accountsRig()
    expect(await call('accounts', undefined, 'ada-holm/notes')).toMatchObject({ current: null })
    expect(await call('status', undefined, 'ada-holm/notes')).toEqual({
      account: null,
      missingScopes: [],
    })
  })

  it("links the caller's vault to an account already in the store", async () => {
    const { call, calls } = accountsRig()
    await call('useAccount', { sub: 'sub-1' }, 'ada-holm/notes')
    expect(calls).toEqual([{ name: 'link', arg: { r: 'ada-holm/notes', sub: 'sub-1' } }])
  })

  it('unlinks this vault without touching the account or any other vault', async () => {
    const { call, calls, links } = accountsRig()
    await call('disconnectVault', undefined, 'syv/work')
    expect(calls).toEqual([{ name: 'unlinkVault', arg: 'syv/work' }])
    expect(links.has('syv/work')).toBe(false)
  })

  it('removes an account by name, taking every vault using it down with it', async () => {
    const { call, links } = accountsRig()
    await call('useAccount', { sub: 'sub-1' }, 'syv/work')
    await call('removeAccount', { sub: 'sub-1' }, 'syv/work')
    expect(links.has('syv/work')).toBe(false)
  })
})
