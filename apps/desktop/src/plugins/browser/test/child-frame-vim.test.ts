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
  let evaluation: (Deferred<void> & { entered: Deferred<void> }) | null = null
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
        const paused = evaluation
        if (paused) {
          paused.entered.resolve()
          await paused.promise
        }
        valid(capture)
        return result
      },
      isCurrent(address: object) {
        const capture = addresses.get(address)
        if (!capture) return false
        try {
          valid(capture)
          return true
        } catch {
          return false
        }
      },
      async observeFocus(address: object, onChange: (focused: boolean) => void) {
        const capture = addresses.get(address)
        if (!capture) throw new Error('unknown address')
        valid(capture)
        const report = (event: Event) => {
          if (!event.isTrusted) return
          try {
            valid(capture)
          } catch {
            return
          }
          onChange(event.type === 'focus')
        }
        dom.window.addEventListener('focus', report, true)
        dom.window.addEventListener('blur', report, true)
        return () => {
          dom.window.removeEventListener('focus', report, true)
          dom.window.removeEventListener('blur', report, true)
        }
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
    resolutionEntered,
    depart: () => {
      presented = false
    },
    pauseResolution: () => (resolution = deferred<void>()),
    pauseEvaluation: () =>
      (evaluation = Object.assign(deferred<void>(), { entered: deferred<void>() })),
  }
}

describe('child-frame editing ownership', () => {
  it('settles pending configuration when native contents disappear before presentation can be read', async () => {
    let destroyed = false
    const contents = { isDestroyed: () => destroyed }
    const vim = createChildFrameVim(
      contents as never,
      () => {
        if (destroyed) throw new Error('native view presentation is unavailable after destruction')
        return true
      },
      () => {},
    )
    const pending = vim.configure(true)
    destroyed = true
    await expect(pending).resolves.toBeUndefined()
    expect(await vim.mode()).toBeNull()
    vim.dispose()
  })

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
    await gate.entered.promise
    h.depart()
    h.contents.focusedFrame = { detached: false }
    gate.resolve()
    expect(await pending).toBeNull()
    h.vim.dispose()
  })

  it('can refocus a document whose arming response arrived during focus departure', async () => {
    const h = await setup()
    const frame = h.contents.focusedFrame
    const field = h.dom.window.document.querySelector('input')!
    field.focus()
    const gate = h.pauseEvaluation()
    const pending = h.vim.mode()
    await gate.entered.promise
    field.blur()
    h.contents.focusedFrame = { detached: false }
    gate.resolve()
    expect(await pending).toBeNull()
    h.contents.focusedFrame = frame
    field.focus()
    expect(await h.vim.mode()).toMatchObject({ mode: 'insert', enabled: true })
    h.vim.dispose()
  })

  it('rejects pending and queued observations after focus leaves and returns', async () => {
    const h = await setup()
    const field = h.dom.window.document.querySelector('input')!
    field.focus()
    const queued = await h.vim.mode()
    expect(queued?.current()).toBe(true)
    const gate = h.pauseEvaluation()
    const pending = h.vim.mode()
    await gate.entered.promise
    field.blur()
    field.focus()
    gate.resolve()
    expect(await pending).toBeNull()
    expect(queued?.current()).toBe(false)
    expect(await h.vim.mode()).toMatchObject({ mode: 'insert', enabled: true })
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
