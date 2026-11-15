import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import { createAppFrameLeases } from '../src/main/plugin-host/app-frame-leases'
import { trackAppFrameDocuments } from '../src/main/plugin-host/app-frame-navigation'

describe('native app document lifetime', () => {
  const setup = () => {
    const contents = new EventEmitter() as WebContents
    const window = { isDestroyed: () => false } as BrowserWindow
    const leases = createAppFrameLeases()
    const trackedWindow = trackAppFrameDocuments({
      contents,
      window,
      leases,
      tokenFromUrl: (url) => new URL(url).hostname.match(/^t([a-f\d]{48})\./)?.[1] ?? null,
    })
    return { contents, window, leases, trackedWindow }
  }

  const issue = (leases: ReturnType<typeof createAppFrameLeases>, window: BrowserWindow) =>
    leases.issue({
      remote: 'ada/a',
      root: '/vault',
      bundle: 'Same/Tool.app',
      activation: 1,
      window,
      current: () => true,
    })

  it('revokes replacement navigation but retains same-document navigation', () => {
    const { contents, window, leases, trackedWindow } = setup()
    const lease = issue(leases, window)
    const frame = {
      processId: 4,
      routingId: 9,
      frameTreeNodeId: 91,
      detached: false,
    } as WebFrameMain
    const navigate = (url: string, sameDocument = false, isMainFrame = false): void => {
      contents.emit('did-start-navigation', {
        frame,
        isMainFrame,
        isSameDocument: sameDocument,
        url,
      })
    }
    navigate(`holi-app://t${lease.token}.app/index.html`)
    expect(leases.resolve(lease.token, window)).toBe(lease)
    navigate(`holi-app://t${lease.token}.app/index.html#section`, true)
    expect(leases.resolve(lease.token, window)).toBe(lease)
    navigate('data:image/svg+xml,<svg/>')
    expect(leases.resolve(lease.token, window)).toBeNull()
    trackedWindow()
  })

  it('rejects a lease as soon as its native child frame is detached', () => {
    const { contents, window, leases, trackedWindow } = setup()
    const lease = issue(leases, window)
    const frame = {
      processId: 4,
      routingId: 9,
      frameTreeNodeId: 91,
      detached: false,
    } as WebFrameMain
    contents.emit('did-start-navigation', {
      frame,
      isMainFrame: false,
      isSameDocument: false,
      url: `holi-app://t${lease.token}.app/index.html`,
    })
    expect(leases.resolve(lease.token, window)).toBe(lease)
    frame.detached = true
    expect(leases.resolve(lease.token, window)).toBeNull()
    expect(
      leases.validate({
        token: lease.token,
        nonce: lease.nonce,
        window,
        remote: lease.remote,
        bundle: lease.bundle,
      }),
    ).toBeNull()
    trackedWindow()
  })

  it('revokes bound and unbound leases only for this window on root navigation and renderer loss', () => {
    const { contents, window, leases, trackedWindow } = setup()
    const otherWindow = { isDestroyed: () => false } as BrowserWindow
    const bound = issue(leases, window)
    const unbound = issue(leases, window)
    const other = issue(leases, otherWindow)
    const frame = {
      processId: 4,
      routingId: 9,
      frameTreeNodeId: 91,
      detached: false,
    } as WebFrameMain
    contents.emit('did-start-navigation', {
      frame,
      isMainFrame: false,
      isSameDocument: false,
      url: `holi-app://t${bound.token}.app/index.html`,
    })
    contents.emit('did-start-navigation', {
      frame: null,
      isMainFrame: true,
      isSameDocument: false,
      url: 'file:///reload',
    })
    expect(leases.resolve(bound.token, window)).toBeNull()
    expect(leases.resolve(unbound.token, window)).toBeNull()
    expect(leases.resolve(other.token, otherWindow)).toBe(other)

    const afterCrash = issue(leases, window)
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(leases.resolve(afterCrash.token, window)).toBeNull()
    expect(leases.resolve(other.token, otherWindow)).toBe(other)
    trackedWindow()
  })
})
