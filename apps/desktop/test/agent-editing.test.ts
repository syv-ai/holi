import { describe, expect, it } from 'vitest'
import { agentEditingIn } from '../src/renderer/src/collab/provider'

/**
 * The read half of D37's `agentEditing`. Main publishes it (`vault-mirror.ts`
 * `onTurnState`) for the span of an agent turn; until now nothing consumed it, so the
 * system prompt's "the user sees a 'Claude is editing…' marker" was false.
 *
 * `vault-mirror.test.ts` already pins the publish half end-to-end over a real room
 * (it asserts a peer's awareness receives `true`). This pins the decision made on the
 * receiving side, which is the part that has branches worth being sure about.
 */
describe('agentEditingIn (D37 — the agent-on-this-doc marker)', () => {
  const LOCAL = 1

  it('reports an agent turn from a peer', () => {
    expect(agentEditingIn([[2, { agentEditing: true }]], LOCAL)).toBe(true)
  })

  it('is quiet when no one is editing', () => {
    expect(agentEditingIn([[2, { user: { name: 'Nicolai' } }]], LOCAL)).toBe(false)
  })

  // Main clears the field with `null`, not by dropping the key — so absence of the key
  // and a null value must read the same, or the marker would stick on after the turn.
  it('treats a cleared field as not editing', () => {
    expect(agentEditingIn([[2, { agentEditing: null }]], LOCAL)).toBe(false)
  })

  // Guards the strict `=== true`: awareness is JSON off the wire, so a stale or
  // hand-rolled peer could put anything here. Only the literal we publish counts.
  it('does not accept a truthy non-true value', () => {
    expect(agentEditingIn([[2, { agentEditing: 'yes' }]], LOCAL)).toBe(false)
  })

  it('finds the agent among several peers', () => {
    expect(
      agentEditingIn(
        [
          [2, { user: { name: 'Nicolai' } }],
          [3, { agentEditing: true }],
        ],
        LOCAL,
      ),
    ).toBe(true)
  })

  // A renderer only ever sets `user`, so this cannot fire today — it is here so that a
  // renderer which someday publishes the field cannot make the marker report itself.
  it('ignores our own state', () => {
    expect(agentEditingIn([[LOCAL, { agentEditing: true }]], LOCAL)).toBe(false)
  })

  it('is quiet in an empty room', () => {
    expect(agentEditingIn([], LOCAL)).toBe(false)
  })
})
