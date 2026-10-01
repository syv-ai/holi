import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  bundleCodeHash,
  bundleAuthorship,
  commitLogin,
  createAppGrants,
  GRANT_TTL_MS,
} from '../main/grants'

const git = promisify(execFile)

let root: string
let store: string
let clock: number

async function put(rel: string, text: string | Buffer): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), text)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-grants-'))
  store = join(await mkdtemp(join(tmpdir(), 'holi-grants-store-')), 'app-grants.json')
  clock = 1_000_000
  await git('git', ['init', '-q'], { cwd: root })
  await put('Mail.app/index.html', '<p>hi</p>')
  await put('Mail.app/app.yaml', 'dangerously-allow: [mail]\n')
})

const grants = () => createAppGrants(store, () => clock)

/** Approve what the app declares, for the code as it is now. */
async function approve(g: ReturnType<typeof grants>, bundle: string, affordances: string[]) {
  const { codeHash } = await g.status('o/r', root, bundle)
  return g.grant('o/r', root, bundle, affordances, codeHash)
}

const granted = async (g: ReturnType<typeof grants>, bundle: string, remote = 'o/r') =>
  (await g.status(remote, root, bundle)).affordances

describe('bundleCodeHash', () => {
  it('ignores records and changes with the code', async () => {
    const before = await bundleCodeHash(root, 'Mail.app')
    await put('Mail.app/data/items/a.json', '{}\n')
    expect(await bundleCodeHash(root, 'Mail.app')).toBe(before)
    await put('Mail.app/index.html', '<p>changed</p>')
    expect(await bundleCodeHash(root, 'Mail.app')).not.toBe(before)
  })

  it('cannot be kept by moving bytes across a file boundary', async () => {
    // One file whose bytes spell out a second file's entry must not hash like
    // two files.
    await put('A.app/index.html', Buffer.from('<p>\u0000A.app/x.js\u0000evil()'))
    const one = await bundleCodeHash(root, 'A.app')
    await put('A.app/index.html', '<p>')
    await put('A.app/x.js', 'evil()')
    expect(await bundleCodeHash(root, 'A.app')).not.toBe(one)
  })

  it("covers node_modules and a symlink's target, which the protocol serves", async () => {
    const before = await bundleCodeHash(root, 'Mail.app')
    await put('Mail.app/node_modules/lib.js', 'x')
    const withLib = await bundleCodeHash(root, 'Mail.app')
    expect(withLib).not.toBe(before)
    await symlink('../elsewhere.js', join(root, 'Mail.app/app.js'))
    const linked = await bundleCodeHash(root, 'Mail.app')
    expect(linked).not.toBe(withLib)
  })
})

describe('app grants', () => {
  it('lists nothing for an app that declares no affordance', async () => {
    await put('Plain.app/index.html', '')
    await put('Plain.app/app.yaml', '')
    expect(await granted(grants(), 'Plain.app')).toEqual([])
  })

  it('is ungranted until approved, then granted', async () => {
    const g = grants()
    expect(await granted(g, 'Mail.app')).toEqual([{ affordance: 'mail', granted: false }])
    expect(await approve(g, 'Mail.app', ['mail'])).toBe(true)
    expect(await granted(g, 'Mail.app')).toEqual([{ affordance: 'mail', granted: true }])
  })

  it('refuses an approval for code that changed after the dialog was shown', async () => {
    const g = grants()
    const { codeHash } = await g.status('o/r', root, 'Mail.app')
    await put('Mail.app/index.html', '<script>fetch("x")</script>')
    expect(await g.grant('o/r', root, 'Mail.app', ['mail'], codeHash)).toBe(false)
    expect(await granted(g, 'Mail.app')).toEqual([{ affordance: 'mail', granted: false }])
  })

  it('never grants what the manifest does not declare', async () => {
    const g = grants()
    await approve(g, 'Mail.app', ['calendar'])
    await put('Mail.app/app.yaml', 'dangerously-allow: [mail, calendar]\n')
    expect(await granted(g, 'Mail.app')).toEqual([
      { affordance: 'mail', granted: false },
      { affordance: 'calendar', granted: false },
    ])
  })

  it('lapses after the TTL', async () => {
    const g = grants()
    await approve(g, 'Mail.app', ['mail'])
    clock += GRANT_TTL_MS
    expect(await granted(g, 'Mail.app')).toEqual([{ affordance: 'mail', granted: false }])
  })

  it('lapses when the code changes', async () => {
    const g = grants()
    await approve(g, 'Mail.app', ['mail'])
    await put('Mail.app/index.html', '<script>fetch("x")</script>')
    expect(await granted(g, 'Mail.app')).toEqual([{ affordance: 'mail', granted: false }])
  })

  it('is per vault', async () => {
    const g = grants()
    await approve(g, 'Mail.app', ['mail'])
    expect(await granted(g, 'Mail.app', 'o/other')).toEqual([
      { affordance: 'mail', granted: false },
    ])
  })

  it('needs no approval for a personal app', async () => {
    await put('Mine.local.app/index.html', '')
    await put('Mine.local.app/app.yaml', 'dangerously-allow: [calendar]\n')
    expect(await granted(grants(), 'Mine.local.app')).toEqual([
      { affordance: 'calendar', granted: true },
    ])
  })

  it('treats a .local. app that git tracks as shared: someone pushed it', async () => {
    await put('Mine.local.app/index.html', '')
    await put('Mine.local.app/app.yaml', 'dangerously-allow: [mail]\n')
    await git('git', ['add', '-f', 'Mine.local.app'], { cwd: root })
    expect(await granted(grants(), 'Mine.local.app')).toEqual([
      { affordance: 'mail', granted: false },
    ])
  })

  it('keeps both of two approvals made at once', async () => {
    await put('Cal.app/index.html', '')
    await put('Cal.app/app.yaml', 'dangerously-allow: [calendar]\n')
    const g = grants()
    await Promise.all([approve(g, 'Mail.app', ['mail']), approve(g, 'Cal.app', ['calendar'])])
    expect((await granted(g, 'Mail.app'))[0]!.granted).toBe(true)
    expect((await granted(g, 'Cal.app'))[0]!.granted).toBe(true)
  })
})

describe('bundleAuthorship', () => {
  const commit = async (as: string, message: string) => {
    await git('git', ['add', '-A'], { cwd: root })
    await git(
      'git',
      ['-c', `user.name=${as}`, '-c', 'user.email=ada@syv.ai', 'commit', '-qm', message],
      { cwd: root },
    )
  }

  it('is nothing before the code is committed', async () => {
    expect(await bundleAuthorship(root, 'Mail.app')).toEqual({ added: null, last: null })
  })

  // The dialog names the code being approved, and records are not code.
  it('names who added the code and who last changed it, not its records', async () => {
    await commit('Ada Holm', 'the app')
    await put('Mail.app/index.html', '<p>v2</p>')
    await commit('Bo Lind', 'v2')
    await put('Mail.app/data/items/a.json', '{}')
    await commit('Cy Ray', 'a record')
    const { added, last } = await bundleAuthorship(root, 'Mail.app')
    expect(added?.author).toBe('Ada Holm')
    expect(last?.author).toBe('Bo Lind')
  })
})

describe('commitLogin', () => {
  const by = (author: string, email: string) => ({ sha: 'a', author, email, date: '' })

  it('reads a GitHub noreply address, or a name that is a member login, and guesses nothing else', () => {
    expect(commitLogin(by('Ada Holm', '123+adaholm@users.noreply.github.com'), [])).toBe('adaholm')
    expect(commitLogin(by('AdaHolm', 'ada@syv.ai'), ['adaholm'])).toBe('adaholm')
    expect(commitLogin(by('Ada Holm', 'ada@syv.ai'), ['adaholm'])).toBeNull()
  })
})
