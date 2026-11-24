import { describe, expect, it } from 'vitest'
import {
  allowNativeNotificationPermission,
  clickNativeBanner,
} from '../scripts/notification-os.mjs'

describe('native notification controls', () => {
  it('cancels before starting OS interaction', async () => {
    const signal = AbortSignal.abort()
    await expect(
      clickNativeBanner({ appName: 'Owned app', title: 'nonce', signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      allowNativeNotificationPermission({ appName: 'Owned app', signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('requires an exact app and title rather than allowing a broad notification click', async () => {
    await expect(clickNativeBanner({ appName: '', title: 'nonce' })).rejects.toThrow(TypeError)
    await expect(
      clickNativeBanner({ appName: 'Holi fixture', title: 'nonce', timeoutMs: 90_001 }),
    ).rejects.toThrow(RangeError)
  })
})
