import { describe, expect, it } from 'vitest'
import { describeGitStatus } from '../src/renderer/src/state/git'

describe('describeGitStatus', () => {
  it('renders the not-connected state', () => {
    expect(describeGitStatus(null)).toEqual({ label: 'Not connected', tone: 'idle' })
  })
  it('renders ok with last export time', () => {
    const s = describeGitStatus({
      repoUrl: 'https://github.com/o/r',
      defaultBranch: 'main',
      status: 'ok',
      statusDetail: null,
      warnings: [],
      lastExportAt: '2026-07-13T10:00:00.000Z',
      lastIngestAt: null,
    })
    expect(s.label).toContain('Synced')
    expect(s.tone).toBe('ok')
  })
  it('surfaces attention with the detail', () => {
    const s = describeGitStatus({
      repoUrl: 'https://github.com/o/r',
      defaultBranch: 'main',
      status: 'attention',
      statusDetail: 'remote history was rewritten',
      warnings: [],
      lastExportAt: null,
      lastIngestAt: null,
    })
    expect(s.label).toContain('needs attention')
    expect(s.tone).toBe('error')
  })
})
