/**
 * Holis: a vault file says who the agent is and what it does; a person sends
 * it a document, and it runs in an agent tab once this machine approved
 * exactly what the file says now.
 *
 * The cases that would catch a real bug: a Holi never runs unapproved or
 * changed (a pull or the agent can write the file), approval is the person's
 * act at the UI door, a send carries the Holi's rules and instructions and
 * names the document, it takes only the documents it accepts, a scheduled Holi
 * runs on no machine, and a report lands on the run it is about. The file's
 * grammar is `packages/shared`'s tests.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { jsonFileStore } from '../../../main/plugin-api'
import { holiCapabilities } from '../main/holis/capabilities'
import { createHolis, parseHolisFile, type Holis, type NeedsYou } from '../main/holis/holis'

const REMOTE = 'syv-ai/notes'
let root: string
let data: string
let started: Parameters<Parameters<typeof createHolis>[0]['sessions']['start']>[0][]
let emitted: string[]
let asked: NeedsYou[]
let holis: Holis
const vault = () => ({ remote: REMOTE, root })

const PROPOSAL = `name: Proposal
model: sonnet
accepts:
  - kunder/**/*.md
allow:
  - Edit(tilbud/**)
instructions: |
  Write a proposal laid out as Templates/proposal.typ.
`

async function writeHoli(name: string, text: string) {
  await mkdir(join(root, '.holi/holis'), { recursive: true })
  await writeFile(join(root, '.holi/holis', name), text)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-holis-'))
  data = await mkdtemp(join(tmpdir(), 'holi-holis-data-'))
  started = []
  emitted = []
  asked = []
  holis = createHolis({
    store: jsonFileStore(join(data, 'holis.json'), parseHolisFile),
    sessions: {
      async start(args) {
        started.push(args)
        return { ok: true, sessionId: `job${started.length}`, terminalId: `term${started.length}` }
      },
    },
    emit: (_remote, name) => emitted.push(name),
    needsYou: (n) => asked.push(n),
    now: () => new Date(2026, 9, 20, 10, 0),
  })
})

afterEach(async () => {
  await Promise.all([root, data].map((d) => rm(d, { recursive: true, force: true })))
})

const approved = async (): Promise<void> => {
  await writeHoli('proposal.yaml', PROPOSAL)
  const [p] = await holis.list(vault())
  await holis.approve(vault(), 'proposal', p!.fingerprint!)
}

describe('approval', () => {
  it('sends nothing to a Holi this machine has not approved', async () => {
    await writeHoli('proposal.yaml', PROPOSAL)
    expect((await holis.list(vault()))[0]!.status).toBe('new')
    await expect(holis.send(vault(), 'proposal', { path: 'kunder/a.md' })).rejects.toThrow(
      /not approved/,
    )
    expect(started).toEqual([])
  })

  it('asks again after a change to what it does, and not after a new name or face', async () => {
    await approved()
    await writeHoli('proposal.yaml', PROPOSAL.replace('name: Proposal', 'name: Offer\nmascot: cat'))
    expect((await holis.list(vault()))[0]!.status).toBe('approved')
    await writeHoli('proposal.yaml', PROPOSAL.replace('tilbud/**', '**/*.md'))
    expect((await holis.list(vault()))[0]!.status).toBe('changed')
    await expect(holis.send(vault(), 'proposal', { path: 'kunder/a.md' })).rejects.toThrow(
      /changed/,
    )
  })

  it('approves only what the dialog showed, not a file written since', async () => {
    await writeHoli('proposal.yaml', PROPOSAL)
    const shown = (await holis.list(vault()))[0]!.fingerprint!
    await writeHoli('proposal.yaml', PROPOSAL.replace('Write a proposal', 'Send the mail'))
    await expect(holis.approve(vault(), 'proposal', shown)).rejects.toThrow(/changed since/)
    // Another vault with the same file has approved nothing.
    await approved()
    expect((await holis.list({ remote: 'someone/else', root }))[0]!.status).toBe('new')
  })

  it('is approved, sent work and made only at the UI door', () => {
    const caps = holiCapabilities({ holis })
    expect(caps['holis.approve'].doors).toEqual(['ui'])
    expect(caps['holis.send'].doors).toEqual(['ui'])
    expect(caps['holis.create'].doors).toEqual(['ui'])
    expect(caps['holis.report'].doors).toEqual(['cli'])
  })
})

describe('sending a document', () => {
  it('starts a session with its rules, model and instructions, naming the document', async () => {
    await approved()
    const res = await holis.send(vault(), 'proposal', { path: 'kunder/nordlys.md', cols: 80 })
    expect(res).toEqual({ sessionId: 'job1', terminalId: 'term1' })
    expect(started).toEqual([
      {
        name: 'Proposal · nordlys',
        prompt: 'Work on kunder/nordlys.md.',
        model: 'sonnet',
        allow: ['Edit(tilbud/**)', 'Bash(holi holis report:*)'],
        appendSystemPrompt: expect.stringContaining(
          'Write a proposal laid out as Templates/proposal.typ.',
        ),
        cols: 80,
      },
    ])
    expect(started[0]!.appendSystemPrompt).toContain('holi holis report proposal')
    // The name is a label anyone may change: never what the run reads.
    expect(started[0]!.appendSystemPrompt).not.toContain('Proposal`')
    expect((await holis.list(vault()))[0]!.runs).toEqual([
      { jobId: 'job1', at: new Date(2026, 9, 20, 10, 0).toISOString(), path: 'kunder/nordlys.md' },
    ])
    expect(emitted).toContain('holis')
  })

  it('takes only the documents it accepts', async () => {
    await approved()
    await expect(holis.send(vault(), 'proposal', { path: 'Notes/a.md' })).rejects.toThrow(
      /does not take/,
    )
  })

  it('runs a scheduled Holi on no machine', async () => {
    await writeHoli('tidy.yaml', "cron: '0 3 * * *'\ninstructions: Tidy.\n")
    const [tidy] = await holis.list(vault())
    expect(tidy).toMatchObject({ kind: 'scheduled', status: 'cloud', when: 'Every day at 03:00' })
    await expect(holis.approve(vault(), 'tidy', tidy!.fingerprint!)).rejects.toThrow(/cloud/)
    await expect(holis.send(vault(), 'tidy', { path: 'a.md' })).rejects.toThrow(/scheduled/)
  })
})

describe('reports', () => {
  it('keeps a report on the latest run, and tells the person when it needs them', async () => {
    await approved()
    await holis.send(vault(), 'proposal', { path: 'kunder/a.md' })
    await holis.send(vault(), 'proposal', { path: 'kunder/b.md' })
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

describe('making one', () => {
  it('writes a file that reads back, refusing to write over one', async () => {
    const made = await holis.create(vault(), {
      name: 'Proposal',
      accepts: ['kunder/**/*.md'],
      allow: ['Edit(tilbud/**)'],
      instructions: 'Write it.',
    })
    expect(made).toMatchObject({ id: 'proposal', status: 'new', accepts: ['kunder/**/*.md'] })
    expect(await readFile(join(root, '.holi/holis/proposal.yaml'), 'utf8')).toContain(
      'instructions: |',
    )
    await expect(
      holis.create(vault(), { name: 'Proposal', instructions: 'Again.' }),
    ).rejects.toThrow(/already/)
  })
})
