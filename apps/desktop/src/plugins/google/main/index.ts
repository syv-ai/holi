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
import { accountApi } from './account-api'
import { openGoogleCache } from './cache'
import type { CalendarOverrides } from './calendar'
import { disposeGoogleCapabilities, GOOGLE_NAMESPACES, googleCapabilities } from './capabilities'
import { createGoogleData, type GoogleData } from './data'
import { createMailInvitationSession } from './mail-invitation-session'
import { createMailInvitationStore } from './mail-invitation-store'
import { createMailAttention, MAIL_ATTENTION_EVENT, type MailAttention } from './mail-attention'
import { createMailMarkerStore } from './markers'
import { googleSeed } from './seed'
import { createMeetingCreation } from './meeting-creation'
import type { GoogleSession } from './session'
import { startGoogleTriggers } from './triggers'

type GoogleOwner = {
  accounts: Awaited<ReturnType<typeof import('./electron').createGoogleAccountsManager>>
  mailInvitations: ReturnType<typeof createMailInvitationSession>
  dataForSession: (session: GoogleSession) => GoogleData
  mailAttention: MailAttention
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
        const markersBySub = new Map<string, ReturnType<typeof createMailMarkerStore>>()
        const mailAttention = createMailAttention({
          sessionFor: (remote) => accounts.sessionFor(remote),
          apiFor: (session) => {
            const sub = session.accountSub
            if (sub === null) throw new Error('that Google account is no longer connected')
            return accountApi(sub, (accountSub) => accounts.sessionForSub(accountSub))()
          },
        })
        const dataForSession = (session: GoogleSession): GoogleData => {
          const sub = session.accountSub
          if (sub === null || accounts.sessionForSub(sub) !== session)
            throw new Error('that Google account is no longer connected')
          const held = bySub.get(sub)
          if (held !== undefined) return held.data
          // `sub` becomes a filename. It is a numeric string from Google today, but
          // build a path out of it only after saying so.
          if (!/^[A-Za-z0-9_-]+$/.test(sub)) throw new Error(`unusable Google account id: ${sub}`)
          const cache = openGoogleCache(join(ctx.userData, `google-cache-${sub}.db`))
          cache.ensureShape()
          const data = createGoogleData({
            // Bind this handle to the grant it was created for. A reconnect of
            // the same account retires it instead of lending it the new grant.
            api: accountApi(sub, (accountSub) =>
              bySub.get(accountSub)?.session === session &&
              accounts.sessionForSub(accountSub) === session
                ? session
                : null,
            ),
            cache,
            markers:
              markersBySub.get(sub) ??
              (() => {
                const markers = createMailMarkerStore(ctx.userData, sub)
                markersBySub.set(sub, markers)
                return markers
              })(),
          })
          bySub.set(sub, { data, session })
          return data
        }
        accounts.onChange(async (sub, reason) => {
          try {
            if (sub === null) return
            // Linking another vault does not replace the grant or its shared cache.
            if (bySub.get(sub)?.session === accounts.sessionForSub(sub)) return
            // An old request can still finish after reconnecting the same account.
            // Retire its data handle and cache so it cannot return or persist stale rows.
            bySub.get(sub)?.data.forget()
            bySub.delete(sub)
            if (!/^[A-Za-z0-9_-]+$/.test(sub)) return
            // An expired grant can be reconnected to the same Google identity;
            // keep its durable annotations. Only deliberate account deletion
            // removes them (including an explicit removal after expiry).
            try {
              if (reason === 'removed') {
                const markers = markersBySub.get(sub) ?? createMailMarkerStore(ctx.userData, sub)
                markersBySub.delete(sub)
                await markers.purge()
              }
            } catch (error) {
              throw new Error(
                `Google account was removed, but personal mail markers could not be deleted: ${String(error)}`,
              )
            } finally {
              // Also erase accounts that never opened a data handle this process.
              const retired = openGoogleCache(join(ctx.userData, `google-cache-${sub}.db`))
              retired.retire()
            }
          } finally {
            // A dead grant can be discovered by this module's own queued refresh. Waiting
            // for another refresh from inside that token-expiry callback would queue it
            // behind the poll that is waiting for this callback and deadlock both.
            if (reason === 'expired') {
              void mailAttention
                .refresh({ drain: false })
                .catch((error) => console.warn(`[google mail attention] refresh: ${String(error)}`))
            } else {
              // Deliberate lifecycle changes still drain the retired account before the
              // settings action completes.
              await mailAttention.refresh()
            }
          }
        })
        return {
          accounts,
          dataForSession,
          mailAttention,
          mailInvitations: createMailInvitationSession(createMailInvitationStore(ctx.userData)),
        }
      })()
      owners.set(ctx.userData, ownerPromise)
      void ownerPromise.catch(() => owners.delete(ctx.userData))
    }
    const { accounts, dataForSession, mailInvitations, mailAttention } = await ownerPromise

    /**
     * Keep a removed account's cache off the disk. On `onChange` rather than
     * on the disconnect, because it also fires for a **dead grant**: a revoked
     * or expired connection is just as much "this mail is no longer yours to
     * hold" as a button press.
     */
    const dataFor = async (remote: string): Promise<GoogleData | null> => {
      const session = await accounts.sessionFor(remote)
      return session === null ? null : dataForSession(session)
    }
    // The vault's own Google settings, in its local plugins file: the agenda
    // view, an app, the agent and the triggers all read through them.
    const readSettings = async (root: string) => {
      const { pluginValues } = await readVaultSettings(root)
      return {
        calendars: pluginSettingValue(pluginValues, GOOGLE_INFO, 'calendars') as CalendarOverrides,
        mailNotifications:
          pluginSettingValue(pluginValues, GOOGLE_INFO, 'mailNotifications') === true,
        imageSenders: pluginSettingValue(pluginValues, GOOGLE_INFO, 'imageSenders') as string[],
        imagesFromAllSenders:
          pluginSettingValue(pluginValues, GOOGLE_INFO, 'imagesFromAllSenders') === true,
      }
    }

    const attention = await mailAttention.subscribe({
      remote: ctx.remote,
      signal: ctx.activationSignal,
      notifications: async () => (await readSettings(ctx.root)).mailNotifications,
      changed: (snapshot) => ctx.emit(ctx.remote, MAIL_ATTENTION_EVENT, snapshot),
      notify: (notice) => ctx.notify(notice),
    })

    const capabilities = googleCapabilities({
      accounts,
      mailInvitations,
      meetings: createMeetingCreation({ userData: ctx.userData, accounts }),
      dataFor,
      dataForSession,
      mailAttention: attention,
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
    return async () => {
      if (stopped) return
      stopped = true
      stopTriggers()
      disposeGoogleCapabilities(capabilities)
      await attention.stop()
    }
  },
}
