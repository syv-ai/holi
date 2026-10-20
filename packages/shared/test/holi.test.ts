import { describe, expect, it } from 'vitest'
import {
  editHoliText,
  globToRegExp,
  holiAccepts,
  holiApprovalText,
  holiIdOf,
  holiSlug,
  isHoliFilePath,
  parseHoliFile,
  serializeHoliFile,
  type HoliDef,
} from '../src/holi'
import { isAgentSurfacePath } from '../src/path-safety'
import { describeScheduleWhen } from '../src/schedule'

const PROPOSAL = `# Proposal turns a customer note into a PDF.
name: Proposal
mascot: rocket
color: '#A5A1FF'
description: Turns a customer note into a PDF proposal
model: sonnet
accepts:
  - kunder/**/*.md # customer notes only
allow:
  - Edit(tilbud/**)
instructions: |
  Write a proposal laid out as Templates/proposal.typ.
`

const def = (text: string, path = '.holi/holis/proposal.yaml'): HoliDef => {
  const res = parseHoliFile(text, path)
  if (!res.ok) throw new Error(res.error)
  return res.def
}

const error = (text: string, path = '.holi/holis/x.yaml'): string => {
  const res = parseHoliFile(text, path)
  if (res.ok) throw new Error('expected a refusal')
  return res.error
}

describe('Holi files', () => {
  it('reads a full definition', () => {
    expect(def(PROPOSAL)).toMatchObject({
      id: 'proposal',
      name: 'Proposal',
      mascot: 'rocket',
      color: '#a5a1ff',
      model: 'sonnet',
      accepts: ['kunder/**/*.md'],
      allow: ['Edit(tilbud/**)'],
      instructions: 'Write a proposal laid out as Templates/proposal.typ.',
      unknownKeys: [],
    })
    expect(def(PROPOSAL).when).toBeUndefined()
  })

  it('gives a bare Holi a stable look from its id, and takes any document', () => {
    const a = def('instructions: Tidy.\n', '.holi/holis/scout.yaml')
    expect(a.name).toBe('scout')
    expect(a.mascot).toBe(def('instructions: Tidy.\n', '.holi/holis/scout.yaml').mascot)
    expect(holiAccepts(a, 'anything/at/all.md')).toBe(true)
  })

  it('takes only the documents its globs name', () => {
    const p = def(PROPOSAL)
    expect(holiAccepts(p, 'kunder/nordlys.md')).toBe(true)
    expect(holiAccepts(p, 'kunder/2026/nordlys.md')).toBe(true)
    expect(holiAccepts(p, 'Notes/nordlys.md')).toBe(false)
    expect(globToRegExp('*.md').test('a/b.md')).toBe(false)
    expect(globToRegExp('Meetings/*.md').test('Meetings/x.md')).toBe(true)
  })

  it('keeps a key it does not know, ignoring it with a warning, never refusing', () => {
    expect(def(`${PROPOSAL}retries: 3\n`).unknownKeys).toEqual(['retries'])
    expect(editHoliText(`${PROPOSAL}retries: 3\n`, { model: 'opus' })).toContain('retries: 3')
  })

  it('edits in place, keeping comments and key order', () => {
    const edited = editHoliText(PROPOSAL, { model: 'opus', description: undefined })
    expect(edited).toContain('# Proposal turns a customer note into a PDF.')
    expect(edited).toContain('# customer notes only')
    expect(edited).not.toContain('description:')
    expect(def(edited).model).toBe('opus')
  })

  it('refuses what it cannot run, saying why', () => {
    expect(error('name: X\nmascot: dragon\ninstructions: x\n')).toMatch(/mascot/)
    expect(error('model: "a b"\ninstructions: x\n')).toMatch(/model/)
    expect(error('accepts: [3]\ninstructions: x\n')).toMatch(/accepts/)
    expect(error('name: X\n')).toMatch(/instructions/)
    expect(error('just a line')).toMatch(/map/)
    expect(error('name: [x')).toMatch(/YAML/)
    expect(error('instructions: x\n', '.holi/holis/Bad Name.yaml')).toMatch(/file name/)
  })

  it('refuses any key that would choose how Claude Code asks: its prompts stay', () => {
    for (const fm of ['permissions: auto', 'permission-mode: bypassPermissions']) {
      expect(error(`${fm}\ninstructions: x\n`)).toContain("Claude Code's own prompts")
    }
  })

  it('refuses a rule that lets a run write anywhere', () => {
    for (const rule of ['Edit', 'Write', 'Edit(**)', 'Edit(*)', 'Edit(**/*)']) {
      expect(error(`allow: ['${rule}']\ninstructions: x\n`)).toMatch(/write anywhere/)
    }
    expect(def(`allow: ['Edit(**/task.*.md)']\ninstructions: x\n`).allow).toEqual([
      'Edit(**/task.*.md)',
    ])
  })

  it('names paths and ids', () => {
    expect(isHoliFilePath('.holi/holis/ada.yaml')).toBe(true)
    expect(isHoliFilePath('.holi/holis/ada.local.yaml')).toBe(true)
    expect(isHoliFilePath('.holi/holis/ada.md')).toBe(false)
    expect(isHoliFilePath('.holi/holis/x/ada.yaml')).toBe(false)
    expect(holiIdOf('.holi/holis/ada.local.yaml')).toBe('ada')
    expect(holiSlug('Ådå the Great!')).toBe('ada-the-great')
    expect(isAgentSurfacePath('.holi/holis/ada.yaml')).toBe(true)
  })

  it('writes a file it reads back, its instructions a block', () => {
    const text = serializeHoliFile({
      name: 'Proposal',
      mascot: 'rocket',
      accepts: ['kunder/**/*.md'],
      allow: ['Edit(tilbud/**)'],
      instructions: 'Write it.\n\nThen export it.',
    })
    expect(text).toContain('instructions: |')
    expect(def(text)).toMatchObject({
      accepts: ['kunder/**/*.md'],
      instructions: 'Write it.\n\nThen export it.',
    })
  })
})

describe('scheduled Holis', () => {
  it('reads a cron as a scheduled Holi, which takes no document', () => {
    const tidy = def("cron: '0 3 * * *'\ninstructions: Tidy the notes.\n", '.holi/holis/tidy.yaml')
    expect(describeScheduleWhen(tidy.when!)).toBe('Every day at 03:00')
    expect(holiAccepts(tidy, 'Notes/a.md')).toBe(false)
    expect(error("cron: '0 3 * * *'\naccepts: ['*.md']\ninstructions: x\n")).toMatch(
      /takes no document/,
    )
    expect(error('cron: "* * * * *"\ninstructions: x\n')).toMatch(/every 5 minutes/)
    expect(error('at: 2026-10-09\ninstructions: x\n')).toMatch(/quoted local time/)
  })

  it('keeps the cloud for work on the vault alone', () => {
    expect(error("cron: '0 3 * * *'\ninstructions: Run `holi google draft` for each.\n")).toMatch(
      /scheduled agent/,
    )
    expect(error("cron: '0 3 * * *'\ninstructions: Read USER.local.md first.\n")).toMatch(
      /\.local\./,
    )
  })
})

describe('approval', () => {
  it('approves what a run may do: not its look, its name or its comments', () => {
    const base = holiApprovalText(def(PROPOSAL))
    expect(holiApprovalText(def(PROPOSAL.replace('name: Proposal', 'name: Offer')))).toBe(base)
    expect(holiApprovalText(def(PROPOSAL.replace('mascot: rocket', 'mascot: ghost')))).toBe(base)
    expect(holiApprovalText(def(PROPOSAL.replace('# customer notes only', '')))).toBe(base)
    expect(holiApprovalText(def(PROPOSAL.replace('laid out', 'set out')))).not.toBe(base)
    expect(holiApprovalText(def(PROPOSAL.replace('model: sonnet', 'model: opus')))).not.toBe(base)
    expect(holiApprovalText(def(PROPOSAL.replace('tilbud/**', 'tilbud/2026/**')))).not.toBe(base)
    expect(holiApprovalText(def(PROPOSAL.replace('kunder/**', 'leads/**')))).not.toBe(base)
  })

  it('does not change with trailing whitespace', () => {
    const a = holiApprovalText(def('instructions: "Line one. \\nLine two.\\n\\n\\n"\n'))
    const b = holiApprovalText(def('instructions: |\n  Line one.\n  Line two.\n'))
    expect(a).toBe(b)
  })
})
