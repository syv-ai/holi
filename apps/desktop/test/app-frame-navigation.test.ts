import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import { createAppFrameLeases } from '../src/main/plugin-host/app-frame-leases'
import { trackAppFrameDocuments } from '../src/main/plugin-host/app-frame-navigation'

describe('native app document lifetime', () => {
  it('revokes the leased document synchronously when its native frame starts replacement navigation', () => {
    const contents = new EventEmitter() as WebContents
    const window = { isDestroyed: () => false } as BrowserWindow
    const leases = createAppFrameLeases()
    const lease = leases.issue({
      remote: 'ada/a',
      root: '/vault',
      bundle: 'Same/Tool.app',
      activation: 1,
      window,
      current: () => true,
    })
    const frame = { processId: 4, routingId: 9, frameTreeNodeId: 91 } as WebFrameMain
    const stop = trackAppFrameDocuments({
      contents,
      window,
      leases,
      tokenFromUrl: (url) => new URL(url).hostname.match(/^t([a-f\d]{48})\./)?.[1] ?? null,
    })
    const navigate = (url: string, sameDocument = false): void => {
      contents.emit('did-start-navigation', {
        frame,
        isMainFrame: true,
        isSameDocument: sameDocument,
        url,
      })
    }
    const original = `holi-app://t${lease.token}.app/index.html`
    navigate(original)
    expect(leases.resolve(lease.token, window)).toBe(lease)
    navigate('holi-app://t' + lease.token + '.app/index.html#section', true)
    expect(leases.resolve(lease.token, window)).toBe(lease)
    navigate('data:image/svg+xml,<svg/>')
    expect(leases.resolve(lease.token, window)).toBeNull()
    stop()
  })
})
