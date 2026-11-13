import { describe, expect, it } from 'vitest'
import { createSelectedRuntimeGate } from '../src/main/vault/selected-runtime'

type Runtime = { remote: string; close(): void }

describe('selected runtime adapter', () => {
  it('isolates background and replaced-runtime work, including after awaits', async () => {
    let selected: Runtime | null = null
    const runtimes = new Map<string, Runtime>()
    const gate = createSelectedRuntimeGate({
      selected: () => selected,
      get: (remote) => runtimes.get(remote) ?? null,
    })
    const a = { remote: 'a', close() {} }
    const b = { remote: 'b', close() {} }
    runtimes.set('a', a)
    runtimes.set('b', b)
    selected = b
    const effects: string[] = []
    gate.run('a', () => effects.push('background'))
    gate.run('b', () => effects.push('selected'))
    expect(effects).toEqual(['selected'])

    let finish!: () => void
    const scan = new Promise<void>((resolve) => (finish = resolve))
    const captured = gate.capture('b')!
    const delayed = scan.then(() => {
      if (gate.isCurrent('b', captured)) effects.push('late-b')
    })
    const replacement = { remote: 'b', close() {} }
    runtimes.set('b', replacement)
    selected = replacement
    finish()
    await delayed
    expect(effects).toEqual(['selected'])
  })
})
