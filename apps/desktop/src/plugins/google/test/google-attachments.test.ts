/**
 * `holi google send|draft|reply --attach <path>`: vault files on the agent's
 * mail. At the seam: what reaches the message for a body and its files, and
 * which paths never leave the machine. A real vault folder on disk, a fake
 * data layer in place of Gmail.
 */
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyVaultSnapshot } from '@holi/shared'
import type { CapabilityError } from '../../../main/capabilities/error'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import type { GoogleAccountsManager } from '../main/accounts'
import { googleCapabilities, GOOGLE_NAMESPACES } from '../main/capabilities'
import type { ComposeWrite, GoogleData } from '../main/data'
import { buildRfc822 } from '../main/mime'

let root: string
let outside: string

/** Every file the test writes, as the snapshot lists it. */
const FILES = [
  'proposals/q2.pdf',
  'Møde referat.docx',
  'notes.local.md',
  '.env',
  '.holi/memory/user.md',
  'linked.pdf',
  'linked-dir/secret.pdf',
  'big.bin',
]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-attach-'))
  outside = await mkdtemp(join(tmpdir(), 'holi-outside-'))
  await mkdir(join(root, 'proposals'))
  await mkdir(join(root, '.holi/memory'), { recursive: true })
  await writeFile(join(root, 'proposals/q2.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]))
  await writeFile(join(root, 'Møde referat.docx'), 'referat')
  await writeFile(join(root, 'notes.local.md'), 'mine')
  await writeFile(join(root, '.env'), 'TOKEN=x')
  await writeFile(join(root, '.holi/memory/user.md'), 'memory')
  await writeFile(join(outside, 'secret.pdf'), 'not in the vault')
  await symlink(join(outside, 'secret.pdf'), join(root, 'linked.pdf'))
  await symlink(outside, join(root, 'linked-dir'))
  await writeFile(join(root, 'big.bin'), '')
  await truncate(join(root, 'big.bin'), 26 * 1024 * 1024)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

/** The CLI door over this vault, recording what reached the data layer. */
function rig() {
  const sent: ComposeWrite[] = []
  const data = {
    sendMail: async (input: ComposeWrite) => {
      sent.push(input)
      return { id: 'm-1' }
    },
  } as unknown as GoogleData
  const registry = createCapabilityRegistry()
  registry.register(
    GOOGLE_NAMESPACES,
    googleCapabilities({
      accounts: {} as GoogleAccountsManager,
      dataFor: async () => data,
      settings: { read: async () => ({ calendars: {}, imageSenders: [] }), write: async () => {} },
    }),
  )
  const send = (attach: string[]) =>
    registry.run(
      'google.send',
      'cli',
      {
        remote: 'owner/repo',
        root,
        bundle: null,
        snapshot: async () => ({
          ...emptyVaultSnapshot(),
          files: FILES.map((path) => ({ path, updatedAt: '' })),
        }),
        claims: async () => [],
        core: noCoreServices(),
      },
      { to: 'ada@syv.ai', subject: 'Q2', body: 'Attached.', attach },
    )
  return { send, sent }
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: CapabilityError) => ({ code: e.code, message: e.message }),
  )

describe('a mail with vault files attached', () => {
  it('carries each file whole, typed and named, beside the body', async () => {
    const { send, sent } = rig()
    await send(['proposals/q2.pdf', 'Møde referat.docx'])
    const raw = buildRfc822(sent[0]!.mail)
    const unfolded = raw.replace(/\r\n[ \t]+/g, ' ')

    expect(unfolded).toMatch(/^Content-Type: multipart\/mixed; boundary=/m)
    expect(raw).toContain(Buffer.from('Attached.').toString('base64'))
    expect(unfolded).toContain('Content-Type: application/pdf; name="q2.pdf"')
    expect(raw).toContain(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]).toString('base64'))
    // RFC 2231 continuation carries the Unicode name without an overlong
    // folded header; parser round-trip coverage lives in google-mime.test.ts.
    expect(unfolded).toContain(
      "Content-Disposition: attachment; filename*0*=UTF-8''M%C3%B8de%20referat.docx",
    )
    expect(unfolded).toContain(
      'Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
  })

  it('stays a single-part mail when nothing is attached', async () => {
    const { send, sent } = rig()
    await send([])
    expect(sent[0]!.mail.attachments).toBeUndefined()
  })
})

describe('what never leaves the machine', () => {
  it.each([
    ['a secret file', '.env'],
    ['a local file', 'notes.local.md'],
    ['the agent surface', '.holi/memory/user.md'],
    ['a symlink out of the vault', 'linked.pdf'],
    ['a symlinked parent directory', 'linked-dir/secret.pdf'],
  ])('refuses %s', async (_what, path) => {
    const { send, sent } = rig()
    expect(await refusal(send(['proposals/q2.pdf', path]))).toMatchObject({ code: 'FORBIDDEN' })
    expect(sent).toEqual([])
  })

  it('refuses a path outside the vault', async () => {
    const { send, sent } = rig()
    expect(await refusal(send(['../holi-outside/secret.pdf']))).toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(sent).toEqual([])
  })

  it("refuses more than Gmail's 25 MB, in words", async () => {
    const { send, sent } = rig()
    expect(await refusal(send(['big.bin']))).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/25 MB/),
    })
    expect(sent).toEqual([])
  })
})
