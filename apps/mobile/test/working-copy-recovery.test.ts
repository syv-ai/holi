import { describe, expect, it } from 'vitest'
import { recoveryArtifactNames, recoveryDirectories } from '../app/working-copy-recovery'

describe('working-copy recovery namespaces', () => {
  it('recognizes actual save stages and move journals, not unrelated names', () => {
    expect(
      recoveryArtifactNames(
        ['stage-00000000-0000-0000-0000-000000000000.tmp', 'move-00000000-0000-0000-0000-000000000000.json', 'notes.md'],
        ['stage-FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF.tmp', 'unrelated.journal'],
      ),
    ).toHaveLength(3)
  })

  it('keeps current artifacts nested in the legacy parent namespace', () => {
    const [current, legacy] = recoveryDirectories('/library', '/vault')
    expect(current).toBe(`${legacy}/artifacts`)
  })
})
