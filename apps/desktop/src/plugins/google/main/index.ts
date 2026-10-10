/**
 * Google's main side (docs/features/google.md): the connected accounts, each
 * account's cached data, and the `google.*` capabilities behind the views, a
 * vault app's reads and the agent's `holi google`. It seeds the send gate and
 * the gmail-calendar skill.
 *
 * The connection is a data connector, not identity: it is independent of the
 * GitHub session, and neither sign-out affects the other. Everything it keeps
 * lives in `userData`, per machine and per account, never in a vault, which is
 * a shared git repo.
 */
import { join } from 'node:path'
import { pluginSettingValue } from '@holi/shared'
import { readVaultSettings, writePluginSettings, type MainPlugin } from '../../../main/plugin-api'
import { GOOGLE_INFO } from '../info'
import { GoogleApi } from './api'
import { openGoogleCache, type GoogleCache } from './cache'
import type { CalendarOverrides } from './calendar'
import { GOOGLE_NAMESPACES, googleCapabilities } from './capabilities'
import { createGoogleData, type GoogleData } from './data'
import { googleSeed } from './seed'

export const googleMain: MainPlugin = {
  info: GOOGLE_INFO,
  seed: googleSeed,
  async activateApp(ctx) {
    // The keychain and the system browser: Electron, loaded only when the
    // plugin starts (after `whenReady`), so the module stays importable under
    // plain Node in the tests.
    const { createGoogleAccountsManager } = await import('./electron')
    const accounts = await createGoogleAccountsManager(ctx.userData)

    /**
     * Each account's data, memoized, so switching between two vaults on one
     * account does not re-fetch mail and calendar: one cache file per account.
     */
    const bySub = new Map<string, { data: GoogleData; cache: GoogleCache }>()
    const dataForSub = (sub: string): GoogleData => {
      const held = bySub.get(sub)
      if (held !== undefined) return held.data
      // `sub` becomes a filename. It is a numeric string from Google today, but
      // build a path out of it only after saying so.
      if (!/^[A-Za-z0-9_-]+$/.test(sub)) throw new Error(`unusable Google account id: ${sub}`)
      const cache = openGoogleCache(join(ctx.userData, `google-cache-${sub}.db`))
      cache.ensureShape()
      const data = createGoogleData({
        // Bound to THIS account's session, not to whatever vault is active:
        // the cache and the client it fills from have to be the same account.
        api: () =>
          new GoogleApi({
            accessToken: () => {
              const session = accounts.sessionForSub(sub)
              if (session === null) throw new Error('that Google account is no longer connected')
              return session.getAccessToken()
            },
          }),
        cache,
      })
      bySub.set(sub, { data, cache })
      return data
    }

    /**
     * Keep a removed account's cache off the disk. On `onChange` rather than
     * on the disconnect, because it also fires for a **dead grant**: a revoked
     * or expired connection is just as much "this mail is no longer yours to
     * hold" as a button press.
     */
    const stopWatching = accounts.onChange((sub) => {
      if (sub === null) return // a vault unlinked; the account and its cache live on
      if (accounts.sessionForSub(sub) !== null) return // still connected
      bySub.get(sub)?.data.forget()
      bySub.delete(sub)
    })

    ctx.register(
      GOOGLE_NAMESPACES,
      googleCapabilities({
        accounts,
        dataFor: async (remote) => {
          const sub = (await accounts.sessionFor(remote))?.accountSub ?? null
          return sub === null ? null : dataForSub(sub)
        },
        // The vault's own Google settings, in its local plugins file: the
        // agenda view, an app and the agent all read through them.
        settings: {
          read: async (root) => {
            const { pluginValues } = await readVaultSettings(root)
            return {
              calendars: pluginSettingValue(
                pluginValues,
                GOOGLE_INFO,
                'calendars',
              ) as CalendarOverrides,
              imageSenders: pluginSettingValue(
                pluginValues,
                GOOGLE_INFO,
                'imageSenders',
              ) as string[],
            }
          },
          write: async (root, values) => {
            const refused = await writePluginSettings(root, GOOGLE_INFO.id, values)
            if (refused.length > 0) console.warn(`[google] settings: ${refused.join('; ')}`)
          },
        },
      }),
    )

    return () => {
      accounts.cancelConnect()
      stopWatching()
      for (const { cache } of bySub.values()) cache.close()
      bySub.clear()
    }
  },
}
