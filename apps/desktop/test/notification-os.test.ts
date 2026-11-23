import { describe, expect, it } from 'vitest'
import { clickNativeBanner } from '../scripts/notification-os.mjs'

describe('clickNativeBanner', () => {
  it('requires an exact app and title rather than allowing a broad notification click', async () => {
    await expect(clickNativeBanner({ appName: '', title: 'nonce' })).rejects.toThrow(TypeError)
    await expect(
      clickNativeBanner({ appName: 'Holi fixture', title: 'nonce', timeoutMs: 90_001 }),
    ).rejects.toThrow(RangeError)
  })
})
