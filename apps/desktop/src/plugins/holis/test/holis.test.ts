/**
 * Holis: a vault folder says who the agent is (its soul) and what it may do;
 * a person sends it a document, or an automation runs it, once this machine
 * approved exactly what it says now. Its memory is notes its runs keep.
 *
 * The cases that would catch a real bug: a Holi never runs unapproved or
 * changed (a pull or the agent can write its files, its soul included),
 * approval is the person's act at the UI door, a send carries the Holi's rules,
 * soul and memory and names the document, it takes only the documents it
 * accepts, a report lands on the run it is about, the memory commands keep
 * their file's shape, and the page's saves refuse to write over a run's. The
 * grammar is `packages/shared`'s tests.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { jsonFileStore } from '../../../main/plugin-api'
import { holiCapabilities } from '../main/capabilities'
import {
  createHolis,
  parseHolisFile,
  type HolisDeps,
  type Holis,
  type NeedsYou,
} from '../main/holis'
import { hashOf, readFiles, remember, saveFile } from '../main/memory'

const REMOTE = 'syv-ai/notes'
let root: string
let data: string
let launched: Parameters<HolisDeps['launch']>[0][]
let selectedProvider: 'claude' | 'codex' | 'pi'
let emitted: string[]
let asked: NeedsYou[]
let holis: Holis
const vault = () => ({ remote: REMOTE, root })
const today = new Date(2026, 9, 20, 10, 0)

const PROPOSAL = `name: Proposal
model: sonnet
accepts:
  - kunder/**/*.md
allow:
  - Edit(tilbud/**)
`
const SOUL = '# Soul\n\nWrite a proposal laid out as Templates/proposal.typ.\n'

async function writeHoli(files: { yaml?: string; soul?: string; memory?: string }) {
  const dir = join(root, '.holi/holis/proposal')
  await mkdir(dir, { recursive: true })
  if (files.yaml !== undefined) await writeFile(join(dir, 'holi.yaml'), files.yaml)
  if (files.soul !== undefined) await writeFile(join(dir, 'SOUL.md'), files.soul)
  if (files.memory !== undefined) await writeFile(join(dir, 'MEMORY.md'), files.memory)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-holis-'))
  data = await mkdtemp(join(tmpdir(), 'holi-holis-data-'))
  launched = []
  selectedProvider = 'claude'
  emitted = []
  asked = []
  holis = createHolis({
    store: jsonFileStore(join(data, 'holis.json'), parseHolisFile),
    provider: async () => selectedProvider,
    async launch(args) {
      launched.push(args)
      return { ok: true, sessionId: `job${launched.length}` }
    },
    emit: (_remote, name) => emitted.push(name),
    needsYou: (n) => asked.push(n),
    now: () => today,
  })
})

afterEach(async () => {
  await Promise.all([root, data].map((d) => rm(d, { recursive: true, force: true })))
})

const approved = async (): Promise<void> => {
  await writeHoli({ yaml: PROPOSAL, soul: SOUL })
  const [p] = await holis.list(vault())
  await holis.approve(vault(), 'proposal', p!.fingerprint!)
}

describe('approval', () => {
  it('sends nothing to a Holi this machine has not approved', async () => {
    await writeHoli({ yaml: PROPOSAL, soul: SOUL })
    expect((await holis.list(vault()))[0]).toMatchObject({ status: 'new', folder: true })
    await expect(holis.send(vault(), 'proposal', 'kunder/a.md')).rejects.toThrow(/not approved/)
    expect(launched).toEqual([])
  })

  it('asks again after its soul or rules change, and not after a new name or face', async () => {
    await approved()
    await writeHoli({ yaml: PROPOSAL.replace('name: Proposal', 'name: Offer\nmascot: cat') })
    expect((await holis.list(vault()))[0]!.status).toBe('approved')
    await writeHoli({ soul: SOUL.replace('proposal', 'mail') })
    expect((await holis.list(vault()))[0]!.status).toBe('changed')
    await writeHoli({ soul: SOUL, yaml: PROPOSAL.replace('tilbud/**', 'tilbud/x/**') })
    expect((await holis.list(vault()))[0]!.status).toBe('changed')
  })

  it('does not ask again when only its memory changed', async () => {
    await approved()
    await writeHoli({ memory: '- 2026-10-01 · Prices in DKK\n' })
    expect((await holis.list(vault()))[0]!.status).toBe('approved')
  })

  it('approves only what the dialog showed, not a soul written since', async () => {
    await writeHoli({ yaml: PROPOSAL, soul: SOUL })
    const shown = (await holis.list(vault()))[0]!.fingerprint!
    await writeHoli({ soul: '# Soul\n\nSend the mail.\n' })
    await expect(holis.approve(vault(), 'proposal', shown)).rejects.toThrow(/changed since/)
  })

  it('is approved, sent work, made and saved only at the UI door', () => {
    const caps = holiCapabilities({ holis, changed: () => {} })
    for (const name of [
      'holis.approve',
      'holis.send',
      'holis.create',
      'holis.update',
      'holis.save',
      'holis.context',
    ] as const) {
      expect(caps[name].doors).toEqual(['ui'])
    }
    expect(caps['holis.report'].doors).toEqual(['cli'])
    expect(caps['holis.remember'].doors).toEqual(['cli'])
  })
})

describe('sending a document', () => {
  it('starts a session with its rules, model, soul and memory, naming the document', async () => {
    await approved()
    await writeHoli({ memory: '- 2026-10-01 · Prices in DKK\n' })
    expect(await holis.send(vault(), 'proposal', 'kunder/nordlys.md')).toEqual({
      sessionId: 'job1',
    })
    const run = launched[0]!
    expect(run).toMatchObject({
      name: 'Proposal · nordlys',
      prompt: 'Work on kunder/nordlys.md.',
      provider: 'claude',
      model: 'sonnet',
    })
    expect(run.allow).toEqual(
      expect.arrayContaining([
        'Edit(tilbud/**)',
        'Bash(holi holis report:*)',
        'Bash(holi holis remember:*)',
      ]),
    )
    expect(run.system).toContain('Write a proposal laid out as Templates/proposal.typ.')
    expect(run.system).toContain('<memory>')
    expect(run.system).toContain('Prices in DKK')
    expect(run.system).toContain('holi holis report proposal')
    // The name is a label anyone may change: never what the run reads.
    expect(run.system).not.toContain('Proposal`')
    expect((await holis.list(vault()))[0]!.runs).toEqual([
      { jobId: 'job1', at: today.toISOString(), path: 'kunder/nordlys.md' },
    ])
    expect(emitted).toContain('holis')
  })

  it('selects Pi, keeps the Holi system prompt, and does not send Claude allow rules', async () => {
    selectedProvider = 'pi'
    await writeHoli({ yaml: PROPOSAL.replace('model: sonnet\n', ''), soul: SOUL })
    const [p] = await holis.list(vault())
    await holis.approve(vault(), 'proposal', p!.fingerprint!)

    await holis.send(vault(), 'proposal', 'kunder/nordlys.md')

    expect(launched[0]).toMatchObject({ provider: 'pi', name: 'Proposal · nordlys' })
    expect(launched[0]!.model).toBeUndefined()
    expect(launched[0]!.allow).toBeUndefined()
    expect(launched[0]!.system).toContain('Write a proposal laid out as Templates/proposal.typ.')
  })

  it('takes only the documents it accepts', async () => {
    await approved()
    await expect(holis.send(vault(), 'proposal', 'Notes/a.md')).rejects.toThrow(/does not take/)
  })

  it('gives an automation its soul and memory, with no report line', async () => {
    await approved()
    const ctx = await holis.context(vault(), 'proposal')
    expect(ctx.system).toContain('An automation on this machine')
    expect(ctx.system).not.toContain('holis report')
    expect(ctx.allow).toContain('Bash(holi holis remember:*)')
    expect(ctx.approval).toContain('Templates/proposal.typ')
  })
})

describe('reports', () => {
  it('keeps a report on the latest run, and tells the person when it needs them', async () => {
    await approved()
    await holis.send(vault(), 'proposal', 'kunder/a.md')
    await holis.send(vault(), 'proposal', 'kunder/b.md')
    await holis.report(vault(), 'proposal', 'Draft in tilbud/b.pdf; prices need you.', true)
    const [p] = await holis.list(vault())
    expect(p!.runs[0]).toMatchObject({
      jobId: 'job2',
      report: { text: 'Draft in tilbud/b.pdf; prices need you.', needsYou: true },
    })
    expect(p!.runs[1]!.report).toBeUndefined()
    expect(asked).toEqual([
      {
        remote: REMOTE,
        id: 'proposal',
        name: 'Proposal',
        text: 'Draft in tilbud/b.pdf; prices need you.',
      },
    ])
  })
})

describe('making and editing one', () => {
  it('makes a folder with the next free face, its soul seeded', async () => {
    const made = await holis.create(vault())
    expect(made).toMatchObject({ id: 'captain', name: 'Captain', mascot: 'captain', folder: true })
    expect(await readFile(join(root, '.holi/holis/captain/SOUL.md'), 'utf8')).toContain(
      '## Standing instructions',
    )
    const next = await holis.create(vault())
    expect(next.mascot).toBe('strategist')
    expect((await holis.create(vault(), { name: 'Captain' })).id).toBe('captain-2')
  })

  it('edits its settings in place, keeping a person’s comments', async () => {
    await writeHoli({ yaml: `# mine\n${PROPOSAL}`, soul: SOUL })
    await holis.update(vault(), 'proposal', { name: 'Offer', model: null })
    const text = await readFile(join(root, '.holi/holis/proposal/holi.yaml'), 'utf8')
    expect(text).toContain('# mine')
    expect(text).toContain('name: Offer')
    expect(text).not.toContain('model:')
  })
})

describe('memory', () => {
  const dir = '.holi/holis/proposal'

  it('remembers a dated fact once, secrets redacted', async () => {
    await writeHoli({ yaml: PROPOSAL, soul: SOUL })
    expect(await remember(root, dir, { fact: 'Prices in DKK' }, today)).toBe('remembered')
    expect(await remember(root, dir, { fact: 'Prices in DKK' }, today)).toBe('already remembered')
    await remember(root, dir, { fact: 'key: sk-abcdefghijklmnopqrstuvwxyz' }, today)
    const text = await readFile(join(root, dir, 'MEMORY.md'), 'utf8')
    expect(text).toContain('- 2026-10-20 · Prices in DKK')
    expect(text).toContain('«redacted')
  })

  it('refuses a page save over what a run wrote since', async () => {
    await writeHoli({ yaml: PROPOSAL, soul: SOUL, memory: '' })
    const opened = await readFiles(root, dir)
    await remember(root, dir, { fact: 'Written by a run' }, today)
    const res = await saveFile(root, dir, 'memory', '- mine\n', opened.memoryHash)
    expect(res).toMatchObject({ ok: false, text: expect.stringContaining('Written by a run') })
    const again = await saveFile(root, dir, 'memory', '- mine\n', hashOf(res.ok ? '' : res.text))
    expect(again.ok).toBe(true)
  })
})
