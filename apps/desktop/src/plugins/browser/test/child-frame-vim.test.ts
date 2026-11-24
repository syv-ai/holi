import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const addressing = vi.hoisted(() => ({ createFrameAddressing: vi.fn() }))
vi.mock('../main/frame-addressing', () => addressing)
import { createChildFrameVim } from '../main/child-frame-vim'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const windows: Array<JSDOM['window']> = []
afterEach(() => {
  for (const window of windows.splice(0)) window.close()
})
beforeEach(() => addressing.createFrameAddressing.mockReset())

async function setup() {
  const dom = new JSDOM('<!doctype html><input id="field">', { runScripts: 'outside-only' })
  windows.push(dom.window)
  const frame = { detached: false }
  const contents = { focusedFrame: frame, mainFrame: {}, isDestroyed: () => false }
  let presented = true
  let resolution: Deferred<void> | null = null
  let evaluation: Deferred<void> | null = null
  const entered = deferred<void>()
  const resolutionEntered = deferred<void>()
  addressing.createFrameAddressing.mockImplementation((_contents, current) => {
    const revoked = new WeakSet<object>()
    let disposed = false
    const addresses = new WeakMap<object, object>()
    const leases = new WeakMap<object, WeakMap<object, object>>()
    const valid = (capture: object) => {
      if (disposed || revoked.has(capture) || !current(capture)) throw new Error('departed owner')
    }
    return {
      async resolve(_frame: object, capture: object) {
        valid(capture)
        resolutionEntered.resolve()
        if (resolution) await resolution.promise
        valid(capture)
        let frames = leases.get(capture)
        if (!frames) leases.set(capture, (frames = new WeakMap()))
        let address = frames.get(_frame)
        if (!address) {
          address = {}
          frames.set(_frame, address)
          addresses.set(address, capture)
        }
        return address
      },
      async evaluate(address: object, expression: string) {
        const capture = addresses.get(address)
        if (!capture) throw new Error('unknown address')
        valid(capture)
        // Native evaluation dispatches before awaiting its response. Run the
        // actual expression in its own DOM world, including nonce validation.
        const result = dom.window.eval(expression)
        entered.resolve()
        if (evaluation) await evaluation.promise
        valid(capture)
        return result
      },
      revoke(capture: object) {
        revoked.add(capture)
      },
      dispose() {
        disposed = true
      },
    }
  })
  const vim = createChildFrameVim(
    contents as never,
    () => presented,
    () => {},
  )
  await vim.configure(true)
  return {
    dom,
    contents,
    vim,
    entered,
    resolutionEntered,
    depart: () => {
      presented = false
    },
    pauseResolution: () => (resolution = deferred<void>()),
    pauseEvaluation: () => (evaluation = deferred<void>()),
  }
}

describe('child-frame editing ownership', () => {
  it('rejects pending resolution after revocation', async () => {
    const h = await setup()
    const gate = h.pauseResolution()
    const pending = h.vim.mode()
    await h.resolutionEntered.promise
    void h.vim.revoke()
    gate.resolve()
    expect(await pending).toBeNull()
    expect(await h.vim.mode()).toBeNull()
    h.vim.dispose()
  })

  it('rejects a native result when presentation and focus depart after dispatch', async () => {
    const h = await setup()
    const gate = h.pauseEvaluation()
    const pending = h.vim.mode()
    await h.entered.promise
    h.depart()
    h.contents.focusedFrame = { detached: false }
    gate.resolve()
    expect(await pending).toBeNull()
    h.vim.dispose()
  })

  it('starts a current child in insert mode and stops reporting after disposal', async () => {
    const h = await setup()
    h.dom.window.document.querySelector('input')!.focus()
    expect(await h.vim.mode()).toMatchObject({ mode: 'insert', enabled: true })
    h.vim.dispose()
    expect(await h.vim.mode()).toBeNull()
  })
})
