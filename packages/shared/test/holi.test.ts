import { describe, expect, it } from 'vitest'
import {
  editHoliText,
  globToRegExp,
  HOLI_MASCOTS,
  HOLI_MASCOT_LABELS,
  holiMascotOf,
  holiRuleError,
  LEGACY_HOLI_MASCOTS,
  holiAccepts,
  holiApprovalText,
  holiIdOf,
  holiSlug,
  holiSoul,
  isHoliFilePath,
  isHoliFolderFile,
  parseHoliFile,
  serializeHoliFile,
  SOUL_SEED,
  soulText,
  type HoliDef,
} from '../src/holi'
import { isAgentSurfacePath } from '../src/path-safety'

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
      mascot: 'captain',
      color: '#a5a1ff',
      model: 'sonnet',
      accepts: ['kunder/**/*.md'],
      allow: ['Edit(tilbud/**)'],
      instructions: 'Write a proposal laid out as Templates/proposal.typ.',
      unknownKeys: [],
    })
    expect(def(PROPOSAL).folder).toBe(false)
  })

  it('reads an older arcade mascot as the character that stands in for it', () => {
    expect(def(PROPOSAL.replace('mascot: rocket', 'mascot: frog')).mascot).toBe('champion')
    expect(def(PROPOSAL.replace('mascot: rocket', 'mascot: professor')).mascot).toBe('professor')
    for (const [old, now] of Object.entries(LEGACY_HOLI_MASCOTS)) {
      expect(def(PROPOSAL.replace('mascot: rocket', `mascot: ${old}`)).mascot).toBe(now)
    }
  })

  it('maps every older mascot to its own character', () => {
    const olds = [
      'invader',
      'ghost',
      'robot',
      'cat',
      'skull',
      'crab',
      'mushroom',
      'rocket',
      'dino',
      'frog',
    ]
    expect(Object.keys(LEGACY_HOLI_MASCOTS).sort()).toEqual([...olds].sort())
    expect(new Set(Object.values(LEGACY_HOLI_MASCOTS)).size).toBe(olds.length)
    for (const now of Object.values(LEGACY_HOLI_MASCOTS)) expect(HOLI_MASCOTS).toContain(now)
    for (const m of HOLI_MASCOTS) {
      expect(holiMascotOf(m)).toBe(m)
      expect(HOLI_MASCOT_LABELS[m]).toMatch(/^[A-Z][a-z]+$/)
    }
    expect(holiMascotOf('dragon')).toBeUndefined()
    expect(holiMascotOf('toString')).toBeUndefined()
    expect(holiMascotOf(7)).toBeUndefined()
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
    expect(error('name: X\nmascot: dragon\ninstructions: x\n')).toMatch(/mascot.*captain/)
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

  it('says why one rule is refused before anything is written', () => {
    expect(holiRuleError('Edit(**)')).toMatch(/write anywhere/)
    expect(holiRuleError('Write')).toMatch(/write anywhere/)
    expect(holiRuleError('  ')).toMatch(/one permission rule/)
    expect(holiRuleError('Edit(tilbud/**)')).toBeNull()
    expect(holiRuleError('Bash(holi google read:*)')).toBeNull()
  })

  it('names paths and ids', () => {
    expect(isHoliFilePath('.holi/holis/ada.yaml')).toBe(true)
    expect(isHoliFilePath('.holi/holis/ada.local.yaml')).toBe(true)
    expect(isHoliFilePath('.holi/holis/ada.md')).toBe(false)
    expect(isHoliFilePath('.holi/holis/x/ada.yaml')).toBe(false)
    expect(isHoliFilePath('.holi/holis/ada/holi.yaml')).toBe(true)
    expect(isHoliFilePath('.holi/holis/ada/SOUL.md')).toBe(false)
    expect(isHoliFolderFile('.holi/holis/ada/holi.yaml')).toBe(true)
    expect(holiIdOf('.holi/holis/ada.local.yaml')).toBe('ada')
    expect(holiIdOf('.holi/holis/ada/holi.yaml')).toBe('ada')
    expect(holiSlug('Ådå the Great!')).toBe('ada-the-great')
    expect(isAgentSurfacePath('.holi/holis/ada.yaml')).toBe(true)
  })

  it('writes a folder Holi it reads back, its soul in SOUL.md', () => {
    const text = serializeHoliFile({
      name: 'Proposal',
      mascot: 'captain',
      accepts: ['kunder/**/*.md'],
      allow: ['Edit(tilbud/**)'],
    })
    expect(text).not.toContain('instructions')
    const folder = def(text, '.holi/holis/proposal/holi.yaml')
    expect(folder).toMatchObject({ folder: true, accepts: ['kunder/**/*.md'], instructions: '' })
    expect(holiSoul(folder, soulText('Write it.\n\nThen export it.'))).toContain(
      'Write it.\n\nThen export it.',
    )
    expect(soulText('')).toBe(SOUL_SEED)
  })

  it("reads an older file's instructions as its soul", () => {
    expect(holiSoul(def(PROPOSAL), 'ignored')).toBe(
      'Write a proposal laid out as Templates/proposal.typ.',
    )
  })

  it('sends a clock to automations', () => {
    expect(error("cron: '0 3 * * *'\ninstructions: Tidy.\n")).toMatch(/automation/)
    expect(error("at: '2026-10-09T15:00'\ninstructions: Tidy.\n")).toMatch(/automation/)
  })
})

describe('approval', () => {
  it('approves what a run may do: not its look, its name or its comments', () => {
    const text = (t: string): string => {
      const d = def(t)
      return holiApprovalText(d, holiSoul(d, null))
    }
    const base = text(PROPOSAL)
    expect(text(PROPOSAL.replace('name: Proposal', 'name: Offer'))).toBe(base)
    expect(text(PROPOSAL.replace('mascot: rocket', 'mascot: ghost'))).toBe(base)
    expect(text(PROPOSAL.replace('# customer notes only', ''))).toBe(base)
    expect(text(PROPOSAL.replace('laid out', 'set out'))).not.toBe(base)
    expect(text(PROPOSAL.replace('model: sonnet', 'model: opus'))).not.toBe(base)
    expect(text(PROPOSAL.replace('tilbud/**', 'tilbud/2026/**'))).not.toBe(base)
    expect(text(PROPOSAL.replace('kunder/**', 'leads/**'))).not.toBe(base)
  })

  it("approves a folder Holi's soul", () => {
    const d = def('name: A\n', '.holi/holis/a/holi.yaml')
    expect(holiApprovalText(d, holiSoul(d, '# Soul\n\nBe brief.'))).not.toBe(
      holiApprovalText(d, holiSoul(d, '# Soul\n\nBe thorough.')),
    )
  })

  it('does not change with trailing whitespace', () => {
    const da = def('instructions: "Line one. \\nLine two.\\n\\n\\n"\n')
    const db = def('instructions: |\n  Line one.\n  Line two.\n')
    const a = holiApprovalText(da, holiSoul(da, null))
    const b = holiApprovalText(db, holiSoul(db, null))
    expect(a).toBe(b)
  })
})
