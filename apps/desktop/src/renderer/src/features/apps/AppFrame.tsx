/**
 * A vault app, running.
 *
 * The frame is `sandbox="allow-scripts"` and deliberately **not**
 * `allow-same-origin`: the app's origin is opaque, so it has no cookies, no
 * `localStorage` (it throws), no reach into this document, and no way to fetch
 * `holi-vault://`. Its one route to the vault is `postMessage` to us, and this
 * component is what answers.
 *
 * Two rules make that answer safe, and both are about identity:
 *
 *  - **The source, never the origin.** `event.origin` is the literal string
 *    `"null"` for an opaque origin, so it identifies nothing. `event.source ===
 *    contentWindow` is what says the message came from the frame we mounted.
 *  - **The app never names itself.** Every call goes out with the `appId` this
 *    component was mounted with and the vault the user has open. An app that put
 *    an id in its message would be ignored — otherwise one app could address
 *    another's directory by asking nicely.
 *
 * What it may ask for at all is decided in main (`apps.*`), not here: the
 * process rendering untrusted code must not be the process deciding what that
 * code may read. This side only forwards.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { RotateCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { APP_METHODS, type AppMethod, type AppResponse } from '@holi/shared'
import { Button, Tooltip } from '@/primitives'
import { trpc } from '../../lib/trpc'
import { appIdsAtom, closeAppAtom } from '../../state/apps'
import { openNoteTabAtom } from '../../state/panes'
import { activeRemoteAtom } from '../../state/vaults'

function isAppMethod(value: unknown): value is AppMethod {
  return typeof value === 'string' && (APP_METHODS as readonly string[]).includes(value)
}

/** The `path` out of a call's params, or null when there isn't one. */
function pathOf(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null
  const path = (params as { path?: unknown }).path
  return typeof path === 'string' ? path : null
}

export function AppFrame({ appId }: { appId: string }): React.JSX.Element {
  const appIds = useAtomValue(appIdsAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const openNote = useSetAtom(openNoteTabAtom)
  const closeApp = useSetAtom(closeAppAtom)
  const [reloads, setReloads] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const exists = appIds.includes(appId)

  const answer = useCallback(
    async (method: AppMethod, params: unknown): Promise<unknown> => {
      if (remote === null) throw new Error('no vault is open')
      switch (method) {
        case 'docs.list':
          return await trpc.apps.docs.query({ remote })
        case 'tasks.list':
          return await trpc.apps.tasks.query({ remote })
        case 'docs.read': {
          const path = pathOf(params)
          if (path === null) throw new Error('docs.read needs a path')
          return await trpc.apps.read.query({ remote, path })
        }
        case 'open': {
          const path = pathOf(params)
          if (path === null) throw new Error('open needs a path')
          openNote(path)
          return { ok: true }
        }
      }
    },
    [remote, openNote],
  )

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current
      if (frame === null || event.source !== frame.contentWindow) return
      const msg = event.data as { id?: unknown; method?: unknown; params?: unknown }
      if (msg === null || typeof msg !== 'object' || typeof msg.id !== 'string') return
      const id = msg.id
      const reply = (response: AppResponse): void =>
        frame.contentWindow?.postMessage(response, '*')

      if (!isAppMethod(msg.method)) {
        // Refused as a value rather than dropped: an app that asked for
        // something that does not exist should be able to say so, and a call
        // that never answers is indistinguishable from Holi having hung.
        reply({ id, ok: false, error: `no such method: ${String(msg.method)}` })
        return
      }
      answer(msg.method, msg.params).then(
        (value) => reply({ id, ok: true, value }),
        (err: unknown) => reply({ id, ok: false, error: (err as Error).message }),
      )
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [answer])

  if (!exists) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm">
        <p className="text-muted-foreground">
          <span className="text-foreground">{appId}</span> was deleted.
        </p>
        <Button variant="ghost" onClick={() => closeApp(appId)}>
          close tab
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 items-center justify-end px-2">
        <Tooltip content="reload this app">
          <Button
            variant="ghost"
            className="h-auto p-1 text-muted-foreground hover:text-foreground"
            aria-label="reload"
            onClick={() => setReloads((n) => n + 1)}
          >
            <RotateCw size={13} />
          </Button>
        </Tooltip>
      </div>
      <iframe
        // Remounting is the reload: an app holds nothing across one (its origin
        // is opaque, so there is no storage to keep), so a fresh document IS the
        // fresh start, and it is the only way a frame sheds what it has loaded.
        key={reloads}
        ref={frameRef}
        src={`holi-app://${appId}/index.html`}
        // The frame's accessible name. `title` is the usual attribute for an
        // iframe and is the one the gate bans (it is a browser tooltip on every
        // other element), so the label goes on aria-label — as it does on the
        // mail frame.
        aria-label={appId}
        // `allow-scripts` alone. Adding `allow-same-origin` would let the app
        // remove its own sandbox — and would give it a real origin, which is the
        // isolation this whole feature rests on.
        sandbox="allow-scripts"
        className="min-h-0 flex-1 border-0"
      />
    </div>
  )
}
