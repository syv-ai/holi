import { describe, expect, it } from 'vitest'
import { createRuntimeGate } from '../src/main/vault/runtime-gate'

type Runtime = { remote: string; close(): void }

describe('runtime lookup adapter', () => {
  it('allows background work for every live runtime and rejects replaced runtimes', async () => {
    const runtimes = new Map<string, Runtime>()
    const gate = createRuntimeGate({
      get: (remote) => runtimes.get(remote) ?? null,
    })
    const a = { remote: 'a', close() {} }
    const b = { remote: 'b', close() {} }
    runtimes.set('a', a)
    runtimes.set('b', b)
    const effects: string[] = []
    gate.run('a', () => effects.push('background'))
    gate.run('missing', () => effects.push('missing'))
    gate.run('b', () => effects.push('selected'))
    expect(gate.capture('a')).toBe(a)
    expect(gate.capture('b')).toBe(b)
    expect(gate.capture('missing')).toBeNull()
    expect(effects).toEqual(['background', 'selected'])

    let finish!: () => void
    const scan = new Promise<void>((resolve) => (finish = resolve))
    const captured = gate.capture('b')!
    const delayed = scan.then(() => {
      if (gate.isCurrent('b', captured)) effects.push('late-b')
    })
    const replacement = { remote: 'b', close() {} }
    runtimes.set('b', replacement)
    finish()
    await delayed
    expect(effects).toEqual(['background', 'selected'])
  })
})
