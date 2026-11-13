import test from 'node:test'
import assert from 'node:assert/strict'
import { destinationLabel, handoffTarget } from './handoff.js'

test('builds fixed holi destination preserving unicode and reserved characters', () => {
  const fragment =
    '#vault=syv-ai/team-notes&path=notes/Caf%C3%A9%20%26%20%231.md&heading=next-steps'
  assert.equal(
    handoffTarget(fragment),
    'holi://open?vault=syv-ai%2Fteam-notes&path=notes%2FCaf%C3%A9+%26+%231.md&heading=next-steps',
  )
  assert.equal(destinationLabel(fragment), 'syv-ai/team-notes · notes/Café & #1.md · next-steps')
})

test('does not create a target for absent, malformed, ambiguous, or unsafe input', () => {
  for (const fragment of [
    '',
    '#',
    '#vault=x&path=y',
    '#vault=a/b&vault=c/d&path=x.md',
    '#vault=a/b&path=x.md&redirect=https://evil.test',
    '#vault=a/b&path=%ZZ',
    '#vault=a/b&path=../x.md',
    '#vault=a/b&path=.env',
    '#vault=a/b&path=notes/x.local.md',
    '#vault=a/b&path=.holi/state/x',
    '#vault=a/b&path=x.md&heading=' + 'h'.repeat(201),
  ]) {
    assert.equal(handoffTarget(fragment), null, fragment)
    assert.equal(destinationLabel(fragment), null, fragment)
  }
})
