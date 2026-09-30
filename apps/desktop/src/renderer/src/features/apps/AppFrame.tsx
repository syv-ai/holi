/**
 * A vault app, running.
 *
 * The frame is `sandbox="allow-scripts allow-popups"` and deliberately **not**
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
 *  - **The app never names itself.** Every call goes out with the bundle this
 *    component was mounted with and the vault the user has open. An app that put
 *    an id in its message would be ignored: otherwise one app could address
 *    another's directory by asking nicely.
 *
 * What it may ask for at all is decided in main (`apps.bridge`, which reaches
 * only the capability registry's app door), not here: the process rendering
 * untrusted code must not be the process deciding what that code may read.
 * This side only forwards, after refusing a name that is not a bridge method.
 *
 * It also **tells** the frame when something it can read has changed (a push:
 * a topic name and nothing else, so the app reads it again through main), and
 * before mounting an app that opts into reading Google data it asks the person
 * to approve that (`dangerously-allow`; the approval is kept in main).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  APP_METHODS,
  appHost,
  appName,
  isAppBundlePath,
  isAppSurface,
  type AppAffordance,
  type AppMethod,
  type AppPush,
  type AppResponse,
} from '@holi/shared'
import { cn } from '@/lib/cn'
import { Button, Dialog } from '@/primitives'
import { trpc } from '../../lib/trpc'
import { appPushSignaturesAtom, storeSignatures } from '../../state/app-push'
import { appPathsAtom, closeAppAtom } from '../../state/apps'
import { activeModeAtom } from '../../state/color-scheme'
import {
  appOpensAtom,
  openApp,
  openNoteTabAtom,
  openSingleton,
  workspaceAtom,
} from '../../state/panes'
import { openCommitInHistoryAtom } from '../../state/history'
import { openHomeAtom } from '../../state/home'
import { activeRemoteAtom, snapshotAtom } from '../../state/vaults'

function isAppMethod(value: unknown): value is AppMethod {
  return typeof value === 'string' && (APP_METHODS as readonly string[]).includes(value)
}

/** A string field out of a call's params, or null when there isn't one. */
function fieldOf(params: unknown, key: 'path' | 'surface'): string | null {
  if (params === null || typeof params !== 'object') return null
  const value = (params as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

/** What each affordance reads, for the approval dialog. */
const AFFORDANCE_TEXT: Record<AppAffordance, string> = {
  mail: 'your mail',
  calendar: 'your calendar',
  location: 'where you are',
}

/** The topics this frame is told about: the vault's, and its own collections'. */
function useTopicSignatures(bundle: string): Record<string, string> {
  const vault = useAtomValue(appPushSignaturesAtom)
  const snapshot = useAtomValue(snapshotAtom)
  return useMemo(
    () => ({ ...vault, ...storeSignatures(snapshot, bundle) }),
    [vault, snapshot, bundle],
  )
}

export function AppFrame({ path }: { path: string }): React.JSX.Element {
  const appPaths = useAtomValue(appPathsAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const mode = useAtomValue(activeModeAtom)
  const openNote = useSetAtom(openNoteTabAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const closeApp = useSetAtom(closeAppAtom)
  const openHome = useSetAtom(openHomeAtom)
  const reloads = useAtomValue(appOpensAtom)[path] ?? 0
  const frameRef = useRef<HTMLIFrameElement>(null)
  const exists = appPaths.includes(path)
  const name = appName(path)

  const answer = useCallback(
    async (method: AppMethod, params: unknown): Promise<unknown> => {
      if (remote === null) throw new Error('no vault is open')
      // `open` is the one thing only this process can do. Everything else goes
      // to main with the bundle this frame was mounted with, where the registry
      // decides what an app may reach.
      if (method === 'open') {
        const surface = fieldOf(params, 'surface')
        if (surface !== null) {
          if (!isAppSurface(surface)) throw new Error(`no such view: ${surface}`)
          if (surface === 'home') void openHome()
          else setWorkspace((w) => openSingleton(w, surface))
          return { ok: true }
        }
        const path = fieldOf(params, 'path')
        if (path === null) throw new Error('open needs a path or a view')
        // An app's bundle is a folder: it opens as the app, not as a file.
        if (isAppBundlePath(path)) setWorkspace((w) => openApp(w, path))
        else openNote(path)
        return { ok: true }
      }
      return await trpc.apps.bridge.mutate({ remote, bundle: path, method, params })
    },
    [remote, path, openNote, setWorkspace, openHome],
  )

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current
      if (frame === null || event.source !== frame.contentWindow) return
      const msg = event.data as {
        id?: unknown
        method?: unknown
        params?: unknown
        log?: { level?: unknown; text?: unknown }
      }
      if (msg === null || typeof msg !== 'object') return
      // A line for the app's log: no answer, and a failure to write it is not
      // the app's to hear about. Main checks the level and the bundle.
      if (typeof msg.log === 'object' && msg.log !== null && remote !== null) {
        const { level, text } = msg.log
        if (typeof level === 'string' && typeof text === 'string') {
          trpc.apps.log.mutate({ remote, bundle: path, level, text }).catch(() => {})
        }
        return
      }
      if (typeof msg.id !== 'string') return
      const id = msg.id
      const reply = (response: AppResponse): void => frame.contentWindow?.postMessage(response, '*')

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
  }, [answer, remote, path])

  // Push: post a topic whenever its signature changes, never on mount (the
  // app reads what it needs when it starts). Sent to whatever document the
  // frame holds now; a reload simply starts listening again.
  const signatures = useTopicSignatures(path)
  const lastSignatures = useRef(signatures)
  useEffect(() => {
    const previous = lastSignatures.current
    lastSignatures.current = signatures
    const target = frameRef.current?.contentWindow
    if (target == null) return
    const topics = new Set([...Object.keys(previous), ...Object.keys(signatures)])
    for (const topic of topics) {
      if (previous[topic] !== signatures[topic]) {
        const push: AppPush = { push: topic }
        target.postMessage(push, '*')
      }
    }
  }, [signatures])

  // The approval gate, asked again on every open and reload, since what was
  // approved lapses with time or with a change to the app's code.
  const [ask, setAsk] = useState<{ affordances: AppAffordance[]; codeHash: string } | null>(null)
  // Who added the code being approved and who last changed it, so the person
  // can place it.
  const [authorship, setAuthorship] = useState<Authorship>({ added: null, last: null })
  // The app's own words for why it asks, from its manifest.
  const [reasons, setReasons] = useState<Partial<Record<AppAffordance, string>>>({})
  const [gateOpen, setGateOpen] = useState(false)
  // Location is the browser's, not a bridge call: the frame is allowed to ask
  // only once it is approved, and main refuses it otherwise.
  const [locating, setLocating] = useState(false)
  // Bumped when an approval comes back refused because the code changed while
  // the dialog was up: the new code is asked about, not waved through.
  const [recheck, setRecheck] = useState(0)
  useEffect(() => {
    if (remote === null || !exists) return
    let live = true
    setGateOpen(false)
    trpc.apps.grants
      .query({ remote, bundle: path })
      .then((status) => {
        if (!live) return
        const ungranted = status.affordances.filter((s) => !s.granted).map((s) => s.affordance)
        setLocating(status.affordances.some((s) => s.affordance === 'location' && s.granted))
        setAsk(ungranted.length > 0 ? { affordances: ungranted, codeHash: status.codeHash } : null)
        setAuthorship({ added: status.added ?? null, last: status.lastChange ?? null })
        setReasons(status.reasons ?? {})
        setGateOpen(ungranted.length === 0)
      })
      .catch(() => live && setGateOpen(true))
    return () => {
      live = false
    }
  }, [remote, path, exists, reloads, recheck])

  // The pane the approval is asked in.
  const [pane, setPane] = useState<HTMLDivElement | null>(null)

  // Which document the frame holds: the fade-in waits for this one's load.
  const documentKey = `${path}\n${reloads}\n${mode}`
  const [loaded, setLoaded] = useState<string | null>(null)

  const decide = (allow: boolean): void => {
    const shown = ask
    setAsk(null)
    if (!allow || remote === null || shown === null) {
      setGateOpen(true)
      return
    }
    trpc.apps.grant.mutate({ remote, bundle: path, ...shown }).then(
      (recorded) => {
        if (!recorded) {
          setRecheck((n) => n + 1)
          return
        }
        if (shown.affordances.includes('location')) setLocating(true)
        setGateOpen(true)
      },
      (e: unknown) => {
        console.warn('[apps] grant failed:', e)
        setGateOpen(true)
      },
    )
  }

  if (!exists) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm">
        <p className="text-muted-foreground">
          <span className="text-foreground">{name}</span> was deleted.
        </p>
        <Button variant="ghost" onClick={() => closeApp(path)}>
          close tab
        </Button>
      </div>
    )
  }

  const reads = (ask?.affordances ?? []).map((a) => AFFORDANCE_TEXT[a]).join(' and ')

  return (
    <div ref={setPane} className="relative flex h-full min-h-0 flex-col">
      {ask !== null && (
        // The app as its markup and styles draw it, blurred behind the question:
        // what is being approved, seen. No scripts (`sandbox=""`), so nothing
        // of it runs before the answer, and it takes no pointer or focus.
        <iframe
          src={`holi-app://${appHost(path)}/index.html?mode=${mode}`}
          sandbox=""
          aria-hidden="true"
          tabIndex={-1}
          className="pointer-events-none absolute inset-0 size-full border-0 opacity-60 blur-sm"
        />
      )}
      {ask !== null && (
        // Asked in the app's own pane, where the app would be: the question is
        // about this app, and the rest of Holi stays usable meanwhile.
        <Dialog open onClose={() => decide(false)} size="sm" closable={false} within={pane}>
          <Dialog.Header>
            {name} wants permission to read {reads}
          </Dialog.Header>
          <Dialog.Body>
            <div className="grid gap-3 text-xs leading-relaxed text-muted-foreground">
              <p>
                What it reads, it can store, which may sync to others in this vault or over the
                network. Sounds scary, but it doesn&rsquo;t mean it does these things, just that it
                requests a permission that can potentially be used like that.
              </p>
              <AppsWords asked={ask.affordances} reasons={reasons} />
              <p>
                Allow it if you trust them. Holi will ask again in 30 days, or if the app changes.
              </p>
            </div>
            <WrittenBy authorship={authorship} />
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="ghost" size="sm" onClick={() => decide(false)}>
              Not now
            </Button>
            <Button size="sm" onClick={() => decide(true)}>
              Allow for 30 days
            </Button>
          </Dialog.Footer>
        </Dialog>
      )}
      {gateOpen && (
        <iframe
          // Remounting is the reload: an app holds nothing across one (its origin
          // is opaque, so there is no storage to keep), so a fresh document IS the
          // fresh start, and it is the only way a frame sheds what it has loaded.
          // The pane header's reload button and the agent's `holi app open` both
          // bump the count (`appOpensAtom`).
          key={reloads}
          ref={frameRef}
          // The mode in force goes in the URL, since main themes the document and
          // cannot see the renderer. A mode change reloads the frame.
          src={`holi-app://${appHost(path)}/index.html?mode=${mode}`}
          // The frame's accessible name. `title` is the usual attribute for an
          // iframe and is the one the gate bans (it is a browser tooltip on every
          // other element), so the label goes on aria-label.
          aria-label={name}
          // Never `allow-same-origin`: it would let the app remove its own
          // sandbox and give it a real origin, which is the isolation this whole
          // feature rests on. `allow-popups` only lets a `target=_blank` link
          // reach main, which opens it in the browser and makes no window.
          sandbox="allow-scripts allow-popups"
          // `*`, not the default `src`: the sandbox makes the document's origin
          // opaque, which matches no origin. Main's permission handler is the
          // gate that checks this app's approval.
          allow={locating ? 'geolocation *' : undefined}
          // Hidden until its document has loaded, then faded in: a frame paints
          // whatever it has as it goes, and an app half-styled for a frame or
          // two reads as a glitch. A reload or a mode change starts it over.
          onLoad={() => setLoaded(documentKey)}
          className={cn(
            'min-h-0 flex-1 border-0',
            loaded === documentKey ? 'motion-in-fade' : 'opacity-0',
          )}
        />
      )}
    </div>
  )
}

/**
 * Why the app asks, in its own words (`dangerously-allow` as a map): quoted
 * and attributed, so it reads as the app's claim rather than Holi's. Plain
 * text, capped by the parser. Nothing when the app gave no reason.
 */
function AppsWords({
  asked,
  reasons,
}: {
  asked: readonly AppAffordance[]
  reasons: Partial<Record<AppAffordance, string>>
}): React.JSX.Element | null {
  const said = asked.flatMap((a) => (reasons[a] === undefined ? [] : [[a, reasons[a]!] as const]))
  if (said.length === 0) return null
  return (
    <figure className="grid gap-1">
      <figcaption>The dev&rsquo;s explanation:</figcaption>
      {said.map(([affordance, reason]) => (
        <blockquote key={affordance} className="pt-1.5 italic text-foreground">
          &ldquo;{reason}&rdquo;
        </blockquote>
      ))}
    </figure>
  )
}

type AppCommit = { sha: string; author: string; date: string; login: string | null }
type Authorship = { added: AppCommit | null; last: AppCommit | null }

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** Who wrote the code being approved: the commit that added it and the last
 *  one to change it, from main. The name opens their GitHub profile when main
 *  could tell their login; the hash opens the commit in History. A personal
 *  app never committed was written on this machine. */
function WrittenBy({ authorship }: { authorship: Authorship }): React.JSX.Element {
  const { added, last } = authorship
  return (
    <div className="grid gap-1.5 rounded-xl bg-muted/60 px-4 py-3 text-xs text-muted-foreground">
      {added == null ? (
        <span>Not committed yet: written on this machine.</span>
      ) : (
        <>
          <CommitLine lead="Added by" commit={added} />
          {last != null && last.sha !== added.sha && (
            <CommitLine lead="Last changed by" commit={last} />
          )}
        </>
      )}
    </div>
  )
}

function CommitLine({ lead, commit }: { lead: string; commit: AppCommit }): React.JSX.Element {
  const openCommit = useSetAtom(openCommitInHistoryAtom)
  const link = 'h-auto p-0 text-xs text-foreground'
  return (
    <span className="min-w-0">
      {lead}{' '}
      {commit.login === null ? (
        <span className="text-foreground">{commit.author}</span>
      ) : (
        <Button
          variant="link"
          className={link}
          onClick={() => void window.holi.openExternal(`https://github.com/${commit.login}`)}
        >
          {commit.author}
        </Button>
      )}{' '}
      in{' '}
      <Button
        variant="link"
        className={cn(link, 'font-mono')}
        onClick={() => openCommit(commit.sha)}
      >
        {commit.sha.slice(0, 7)}
      </Button>
      , {day(commit.date)}
    </span>
  )
}
