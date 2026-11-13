import { describe, expect, it, vi } from 'vitest'
import { ComposeSessionGate } from '../renderer/compose-session'

describe('compose session navigation', () => {
  it('refuses an already departed context without asking it to save', async () => {
    const gate = new ComposeSessionGate()
    const prepareToLeave = vi.fn(async () => true)
    gate.begin({ prepareToLeave })
    const navigate = vi.fn()
    expect(await gate.leave(navigate, () => false)).toBe(false)
    expect(prepareToLeave).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('rechecks live context after awaiting persistence', async () => {
    const gate = new ComposeSessionGate()
    let finish!: (saved: boolean) => void
    gate.begin({
      prepareToLeave: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    })
    const navigate = vi.fn()
    let current = true
    const leaving = gate.leave(navigate, () => current)
    current = false
    finish(true)
    expect(await leaving).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not leave when persistence fails', async () => {
    const gate = new ComposeSessionGate()
    const session = gate.begin({ prepareToLeave: async () => false })
    const navigate = vi.fn()
    expect(await gate.leave(navigate)).toBe(false)
    expect(gate.current()?.identity).toBe(session.identity)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not run a prior session action after replacement', async () => {
    const gate = new ComposeSessionGate()
    let finish!: (saved: boolean) => void
    gate.begin({
      prepareToLeave: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    })
    const navigate = vi.fn()
    const leaving = gate.leave(navigate)
    const replacement = gate.begin()
    finish(true)
    expect(await leaving).toBe(false)
    expect(gate.current()?.identity).toBe(replacement.identity)
    expect(navigate).not.toHaveBeenCalled()
  })
})
