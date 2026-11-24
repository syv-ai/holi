import { describe, expect, it } from 'vitest'
import {
  allowNativeNotificationPermission,
  assertMacDesktopAvailable,
  clickNativeBanner,
} from '../scripts/notification-os.mjs'

describe('native notification controls', () => {
  const session = { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true }
  it.skipIf(process.platform !== 'darwin')(
    'accepts a logged-in unlocked desktop without the optional session lock key',
    async () => {
      await expect(
        assertMacDesktopAvailable({
          run: async () => JSON.stringify({ IOConsoleLocked: false, IOConsoleUsers: [session] }),
        }),
      ).resolves.toBeUndefined()
    },
  )
  it.skipIf(process.platform !== 'darwin')(
    'rejects a locked desktop and missing or ambiguous console state',
    async () => {
      for (const state of [
        { IOConsoleLocked: true, IOConsoleUsers: [{ ...session, CGSSessionScreenIsLocked: true }] },
        { IOConsoleLocked: false, IOConsoleUsers: [] },
        { IOConsoleLocked: false, IOConsoleUsers: [session, session] },
        {},
        null,
      ]) {
        await expect(
          assertMacDesktopAvailable({ run: async () => JSON.stringify(state) }),
        ).rejects.toThrow()
      }
    },
  )
  it.skipIf(process.platform !== 'darwin')(
    'honors cancellation before and during the desktop query',
    async () => {
      await expect(
        assertMacDesktopAvailable({ signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ name: 'AbortError' })
      const controller = new AbortController()
      await expect(
        assertMacDesktopAvailable({
          signal: controller.signal,
          run: async () => {
            controller.abort()
            return JSON.stringify({ IOConsoleLocked: false, IOConsoleUsers: [session] })
          },
        }),
      ).rejects.toMatchObject({ name: 'AbortError' })
    },
  )
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
