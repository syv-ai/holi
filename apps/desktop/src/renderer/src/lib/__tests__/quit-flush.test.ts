import { expect, it, vi } from 'vitest'
import { registerBuffer } from '../buffer-registry'
import { listenForQuitFlush } from '../quit-flush'

function channel() {
  let request!: (value: { id: string }) => void
  let cancel!: (value: { id: string }) => void
  const done = vi.fn()
  const stop = listenForQuitFlush({
    onFlushRequest: (cb) => {
      request = cb
      return () => {}
    },
    onFlushCancelled: (cb) => {
      cancel = cb
      return () => {}
    },
    flushDone: done,
  })
  return {
    request: (id: string) => request({ id }),
    cancel: (id: string) => cancel({ id }),
    done,
    stop,
  }
}

it('holds editing frozen after a successful save until shutdown is cancelled', async () => {
  const freeze = vi.fn()
  const off = registerBuffer(async () => {}, undefined, freeze)
  const quit = channel()
  try {
    quit.request('one')
    expect(freeze).toHaveBeenLastCalledWith(true)
    await vi.waitFor(() => expect(quit.done).toHaveBeenCalledWith('one'))
    expect(freeze).toHaveBeenLastCalledWith(true)
    quit.cancel('one')
    expect(freeze).toHaveBeenLastCalledWith(false)
  } finally {
    quit.stop()
    off()
  }
})

it('reports failure, unlocks editing, and allows a fresh quit', async () => {
  const freeze = vi.fn()
  const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
  const off = registerBuffer(save, undefined, freeze)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const quit = channel()
  try {
    quit.request('one')
    await vi.waitFor(() => expect(quit.done).toHaveBeenCalledWith('one', 'disk full'))
    expect(freeze).toHaveBeenLastCalledWith(false)
    quit.request('two')
    await vi.waitFor(() => expect(quit.done).toHaveBeenCalledWith('two'))
    expect(freeze).toHaveBeenLastCalledWith(true)
  } finally {
    quit.stop()
    off()
    log.mockRestore()
  }
})

it('a cancelled slow request cannot unlock the next quit when it completes', async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const freeze = vi.fn()
  const off = registerBuffer(() => pending, undefined, freeze)
  const quit = channel()
  try {
    quit.request('one')
    quit.cancel('one')
    expect(freeze).toHaveBeenLastCalledWith(false)
    quit.request('two')
    finish()
    await vi.waitFor(() => expect(quit.done).toHaveBeenCalledWith('two'))
    expect(freeze).toHaveBeenLastCalledWith(true)
    quit.cancel('one')
    expect(freeze).toHaveBeenLastCalledWith(true)
    quit.cancel('two')
    expect(freeze).toHaveBeenLastCalledWith(false)
  } finally {
    finish()
    quit.stop()
    off()
  }
})
