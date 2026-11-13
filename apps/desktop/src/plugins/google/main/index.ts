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
import { openGoogleCache } from './cache'
import type { CalendarOverrides } from './calendar'
import { disposeGoogleCapabilities, GOOGLE_NAMESPACES, googleCapabilities } from './capabilities'
import { createGoogleData, type GoogleData } from './data'
import { googleSeed } from './seed'
import type { GoogleSession } from './session'
import { startGoogleTriggers } from './triggers'

type GoogleOwner = {
  accounts: Awaited<ReturnType<typeof import('./electron').createGoogleAccountsManager>>
  dataForSub: (sub: string) => GoogleData
}

// Google credentials and mail cache belong to this Electron process, not to a
// particular open vault. Keep the lazy owner across activation leases.
const owners = new Map<string, Promise<GoogleOwner>>()

export const googleMain: MainPlugin = {
  info: GOOGLE_INFO,
  seed: googleSeed,
  async activate(ctx) {
    // The keychain and the system browser: Electron, loaded only when the
    // plugin starts (after `whenReady`), so the module stays importable under
    // plain Node in the tests.
    let ownerPromise = owners.get(ctx.userData)
    if (ownerPromise === undefined) {
      ownerPromise = (async () => {
        const { createGoogleAccountsManager } = await import('./electron')
        const accounts = await createGoogleAccountsManager(ctx.userData)
        const bySub = new Map<string, { data: GoogleData; session: GoogleSession }>()
        const dataForSub = (sub: string): GoogleData => {
          const held = bySub.get(sub)
          if (held !== undefined) return held.data
          // `sub` becomes a filename. It is a numeric string from Google today, but
          // build a path out of it only after saying so.
          if (!/^[A-Za-z0-9_-]+$/.test(sub)) throw new Error(`unusable Google account id: ${sub}`)
          const session = accounts.sessionForSub(sub)
          if (session === null) throw new Error('that Google account is no longer connected')
          const cache = openGoogleCache(join(ctx.userData, `google-cache-${sub}.db`))
          cache.ensureShape()
          const data = createGoogleData({
            // Bind this handle to the grant it was created for. A reconnect of
            // the same account retires it instead of lending it the new grant.
            api: () => {
              if (bySub.get(sub)?.data !== data) {
                throw new Error('that Google account is no longer connected')
              }
              return new GoogleApi({ accessToken: () => session.getAccessToken() })
            },
            cache,
          })
          bySub.set(sub, { data, session })
          return data
        }
        accounts.onChange((sub) => {
          if (sub === null) return
          // Linking another vault does not replace the grant or its shared cache.
          if (bySub.get(sub)?.session === accounts.sessionForSub(sub)) return
          // An old request can still finish after reconnecting the same account.
          // Retire its data handle and cache so it cannot return or persist stale rows.
          bySub.get(sub)?.data.forget()
          bySub.delete(sub)
          if (!/^[A-Za-z0-9_-]+$/.test(sub)) return
          // Also erase accounts that never opened a data handle this process.
          const retired = openGoogleCache(join(ctx.userData, `google-cache-${sub}.db`))
          retired.retire()
        })
        return { accounts, dataForSub }
      })()
      owners.set(ctx.userData, ownerPromise)
      void ownerPromise.catch(() => owners.delete(ctx.userData))
    }
    const { accounts, dataForSub } = await ownerPromise

    /**
     * Keep a removed account's cache off the disk. On `onChange` rather than
     * on the disconnect, because it also fires for a **dead grant**: a revoked
     * or expired connection is just as much "this mail is no longer yours to
     * hold" as a button press.
     */
    const dataFor = async (remote: string): Promise<GoogleData | null> => {
      const sub = (await accounts.sessionFor(remote))?.accountSub ?? null
      return sub === null ? null : dataForSub(sub)
    }
    // The vault's own Google settings, in its local plugins file: the agenda
    // view, an app, the agent and the triggers all read through them.
    const readSettings = async (root: string) => {
      const { pluginValues } = await readVaultSettings(root)
      return {
        calendars: pluginSettingValue(pluginValues, GOOGLE_INFO, 'calendars') as CalendarOverrides,
        imageSenders: pluginSettingValue(pluginValues, GOOGLE_INFO, 'imageSenders') as string[],
      }
    }

    const capabilities = googleCapabilities({
      accounts,
      dataFor,
      settings: {
        read: readSettings,
        write: async (root, values) => {
          const refused = await writePluginSettings(root, GOOGLE_INFO.id, values)
          if (refused.length > 0) console.warn(`[google] settings: ${refused.join('; ')}`)
        },
      },
    })
    ctx.register(GOOGLE_NAMESPACES, capabilities)

    // Mail and the agenda for schedules that run on them, polled only while
    // one listens.
    const stopTriggers = startGoogleTriggers(ctx, {
      data: () => dataFor(ctx.remote),
      overrides: async () => (await readSettings(ctx.root)).calendars,
    })

    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      stopTriggers()
      disposeGoogleCapabilities(capabilities)
    }
  },
}
