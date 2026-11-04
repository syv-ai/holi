import { describe, expect, it } from 'vitest'
import { parseProjectFile, serializeProjectFile } from '../src/project-file'

const FILE = `---
name: Website relaunch
status: active
lead: "@Ada"
start: 2026-09-01
due: 2026-12-15
milestones:
  - name: Launch
    date: 2026-12-01
  - name: Design signed off
    date: 2026-10-01
owner_team: web
---

Rebuild the site on the new stack.
`

describe('project file', () => {
  it('is a planning project with nothing else when there is no file', () => {
    expect(parseProjectFile(null)).toEqual({
      project: { status: 'planning', milestones: [], about: '' },
      warnings: [],
    })
  })

  it('reads every field, milestones in date order, unknown keys kept', () => {
    const { project, warnings } = parseProjectFile(FILE)
    expect(warnings).toEqual([])
    expect(project).toEqual({
      name: 'Website relaunch',
      status: 'active',
      lead: 'Ada',
      start: '2026-09-01',
      due: '2026-12-15',
      milestones: [
        { name: 'Design signed off', date: '2026-10-01' },
        { name: 'Launch', date: '2026-12-01' },
      ],
      about: 'Rebuild the site on the new stack.',
      extra: { owner_team: 'web' },
    })
  })

  it('round-trips: what it writes reads back the same', () => {
    const { project } = parseProjectFile(FILE)
    const text = serializeProjectFile(project)
    expect(parseProjectFile(text).project).toEqual(project)
    expect(serializeProjectFile(parseProjectFile(text).project)).toBe(text)
  })

  it('drops a wrong value with a warning instead of failing', () => {
    const { project, warnings } = parseProjectFile(
      '---\nstatus: shipping\ndue: soon\nmilestones:\n  - name: x\n---\nAbout.\n',
    )
    expect(project).toEqual({ status: 'planning', milestones: [], about: 'About.' })
    expect(warnings).toHaveLength(3)
  })

  it('writes no frontmatter keys for what is not set', () => {
    expect(serializeProjectFile({ status: 'planning', milestones: [], about: '' })).toBe(
      '---\nstatus: planning\n---\n',
    )
  })
})
