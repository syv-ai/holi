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
 * What it may ask for at all is decided in main (`apps.call`, which reaches
 * only the capability registry's app door), not here: the process rendering
 * untrusted code must not be the process deciding what that code may read.
 * This side only forwards, after refusing a name that is not a bridge method.
 *
 * It also **tells** the frame when something it can read has changed (a push:
 * a topic name and nothing else, so the app reads it again through main), and
 * before mounting an app that opts into reading Google data it asks the person
 * to approve that (`dangerously-allow`; the approval is kept in main).
 */
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type AppPush, type AppResponse } from '../shared/bridge'
import { appHost, appName } from '../shared/bundle'
import { type AppAffordance } from '../shared/manifest'
import {
  activeModeAtom,
  activeRemoteAtom,
  closeSurfaceTabAtom,
  cn,
  FileHistoryDialog,
  snapshotAtom,
  openExternal,
} from '@/plugin-api'
import { AppWindow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/composites/empty-state'
import { appPushSignaturesAtom, storeSignatures } from './app-push'
import {
  frameIsUnobscured,
  PREVIEW_SETTLE_MS,
  previewRequestsAtom,
  previewTakenAtom,
} from './app-previews'
import { appCodeGenerationsAtom, appOpensAtom, appPathsAtom } from './apps'
import { appsCap } from './apps-cap'
import { hostBridgeMessage } from './bridge-host'

/** What each affordance reads, for the approval dialog. */
const AFFORDANCE_TEXT: Record<AppAffordance, string> = {
  mail: 'your mail',
  calendar: 'your calendar',
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

/**
 * Take the app's picture for its card once its document has loaded and had
 * a moment to draw, while the browser is idle, and again whenever Refresh
 * preview asks; only while the frame is unobscured (`frameIsUnobscured`).
 * One picture per load: the app's later changes are its own business.
 */
function usePreviewCapture(
  frameRef: React.RefObject<HTMLIFrameElement | null>,
  path: string,
  loaded: string | null,
  visible: boolean,
): void {
  const remote = useAtomValue(activeRemoteAtom)
  const request = useAtomValue(previewRequestsAtom)[path] ?? 0
  const taken = useSetAtom(previewTakenAtom)
  const completed = useRef<string | null>(null)
  useEffect(() => {
    if (!visible || loaded === null || remote === null) return
    const captureKey = JSON.stringify([remote, path, loaded, request])
    if (completed.current === captureKey) return
    let live = true
    let idle: number | null = null
    const take = (): void => {
      const frame = frameRef.current
      if (!live || frame === null || !frameIsUnobscured(frame)) return
      const r = frame.getBoundingClientRect()
      // 2px in from each edge, so a pane's separator beside it is not kept.
      const rect = { x: r.left + 2, y: r.top + 2, width: r.width - 4, height: r.height - 4 }
      appsCap.capturePreview(remote, { bundle: path, rect }).then(
        (res) => {
          if (!live || !res.saved) return
          completed.current = captureKey
          taken(path)
        },
        (e: unknown) => {
          if (live) console.warn('[apps] preview:', e)
        },
      )
    }
    const timer = window.setTimeout(() => {
      idle =
        typeof window.requestIdleCallback === 'function'
          ? window.requestIdleCallback(take, { timeout: 1_000 })
          : null
      if (idle === null) take()
    }, PREVIEW_SETTLE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
      if (idle !== null) window.cancelIdleCallback(idle)
    }
  }, [frameRef, path, loaded, remote, request, taken, visible])
}

export function AppFrame({
  path,
  visible = true,
}: {
  path: string
  visible?: boolean
}): React.JSX.Element {
  const appPaths = useAtomValue(appPathsAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const codeGeneration = useAtomValue(appCodeGenerationsAtom)[remote ?? '']?.[path] ?? 0
  const mode = useAtomValue(activeModeAtom)
  const reloads = useAtomValue(appOpensAtom)[path] ?? 0
  const closeTab = useSetAtom(closeSurfaceTabAtom)
  const [revision, setRevision] = useState(0)
  const recheck = useCallback(() => setRevision((n) => n + 1), [])
  if (!appPaths.includes(path)) {
    return (
      <EmptyState
        icon={AppWindow}
        title={`${appName(path)} was deleted.`}
        action={{ label: 'Close tab', onClick: () => closeTab('app', path) }}
      />
    )
  }
  if (remote === null) return <></>
  // A new identity unmounts the old document in this render, not in an
  // effect after new source might already have run with the old approval.
  return (
    <AppLoad
      key={JSON.stringify([remote, path, mode, reloads, codeGeneration, revision])}
      path={path}
      remote={remote}
      mode={mode}
      visible={visible}
      recheck={recheck}
    />
  )
}

/** One exact vault, bundle generation, mode and reload. All async work is
 * scoped to this load; retaining it changes visibility, never its identity. */
function AppLoad({
  path,
  remote,
  mode,
  visible,
  recheck,
}: {
  path: string
  remote: string
  mode: string
  visible: boolean
  recheck: () => void
}): React.JSX.Element {
  const store = useStore()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const live = useRef(false)
  useLayoutEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const name = appName(path)
  // Every message from the frame we mounted is answered as any frame of
  // this app's code is (`bridge-host.ts`), with the bundle it was mounted
  // with and the vault open now.
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current
      if (!live.current || frame === null || event.source !== frame.contentWindow) return
      const target = frame.contentWindow
      hostBridgeMessage(event.data, {
        store,
        remote,
        bundle: path,
        reply: (response: AppResponse) => {
          if (live.current && frameRef.current === frame && frame.contentWindow === target) {
            target?.postMessage(response, '*')
          }
        },
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [store, remote, path])

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
  const [error, setError] = useState(false)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  useEffect(() => {
    let current = true
    appsCap.grants(remote, { bundle: path }).then(
      (status) => {
        if (!current || !live.current) return
        const ungranted = status.affordances.filter((s) => !s.granted).map((s) => s.affordance)
        setAsk(ungranted.length > 0 ? { affordances: ungranted, codeHash: status.codeHash } : null)
        setAuthorship({ added: status.added ?? null, last: status.lastChange ?? null })
        setReasons(status.reasons ?? {})
        setExpiresAt(status.expiresAt ?? null)
        setGateOpen(ungranted.length === 0)
      },
      () => {
        if (current && live.current) setError(true)
      },
    )
    return () => {
      current = false
    }
  }, [remote, path])

  useEffect(() => {
    if (expiresAt === null) return
    // Grants use main's wall-clock deadline. Check on wake as well as on a
    // timer: a suspended Electron renderer must not keep yesterday's approval.
    const remaining = () => expiresAt - Date.now()
    const check = () => {
      if (live.current && remaining() <= 0) recheck()
    }
    let timer: number
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          if (remaining() <= 0) check()
          else schedule()
        },
        Math.max(0, Math.min(remaining(), 2_147_483_647)),
      )
    }
    schedule()
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [expiresAt, recheck])

  const [loaded, setLoaded] = useState<string | null>(null)
  usePreviewCapture(frameRef, path, gateOpen ? loaded : null, visible)

  const decide = (allow: boolean): void => {
    const shown = ask
    setAsk(null)
    if (!live.current || shown === null) return
    if (!allow) {
      setGateOpen(true)
      return
    }
    appsCap.grant(remote, { bundle: path, ...shown }).then(
      () => {
        if (!live.current) return
        // Re-read a refused or successful grant: main supplies the expiry and checks
        // whether the code still matches. No new source runs before that read.
        recheck()
      },
      (e: unknown) => {
        if (!live.current) return
        console.warn('[apps] grant failed:', e)
        setGateOpen(true)
      },
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={AppWindow}
        title="Could not check app permissions."
        action={{ label: 'Retry', onClick: recheck }}
      />
    )
  }

  const reads = (ask?.affordances ?? []).map((a) => AFFORDANCE_TEXT[a]).join(' and ')

  return (
    <div inert={!visible} aria-hidden={!visible} className="relative flex h-full min-h-0 flex-col">
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
        // Not a modal: it is a card in the pane, so a click elsewhere in Holi
        // is not an answer, and only its buttons or Escape close it.
        <Card
          role="dialog"
          aria-modal="false"
          aria-labelledby="app-approval-title"
          tabIndex={-1}
          ref={(card) => {
            if (visible) card?.focus()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') decide(false)
          }}
          className="absolute top-1/2 left-1/2 z-20 w-11/12 max-w-md -translate-x-1/2 -translate-y-1/2"
        >
          <CardHeader>
            <CardTitle id="app-approval-title">
              {name} wants permission to read {reads}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex min-w-0 flex-col gap-4">
              <div className="grid gap-3 text-sm text-pretty text-muted-foreground">
                <p>
                  {name} can store what it reads, and what it stores may sync to others in this
                  vault or leave this machine. Allow it only if you trust who wrote it.
                </p>
                <AppsWords asked={ask.affordances} reasons={reasons} />
                <p>Holi asks again in 30 days, or sooner if the app changes.</p>
              </div>
              {visible && <WrittenBy path={path} authorship={authorship} />}
            </div>
          </CardContent>
          <CardFooter className="justify-end">
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => decide(false)}>
                Not now
              </Button>
              <Button size="sm" onClick={() => decide(true)}>
                Allow for 30 days
              </Button>
            </div>
          </CardFooter>
        </Card>
      )}
      {gateOpen && (
        <iframe
          // Remounting is the reload: an app holds nothing across one (its origin
          // is opaque, so there is no storage to keep), so a fresh document IS the
          // fresh start, and it is the only way a frame sheds what it has loaded.
          // The pane header's reload button and the agent's `holi apps open` both
          // bump the count (`appOpensAtom`).
          ref={frameRef}
          // The mode in force goes in the URL, since main themes the document and
          // cannot see the renderer. A mode change reloads the frame.
          src={`holi-app://${appHost(path)}/index.html?mode=${mode}`}
          // The frame's accessible name. `title` is the usual attribute for an
          // iframe and is the one the gate bans (it is a browser tooltip on every
          // other element), so the label goes on aria-label.
          aria-label={name}
          aria-hidden={!visible}
          tabIndex={visible ? 0 : -1}
          // Never `allow-same-origin`: it would let the app remove its own
          // sandbox and give it a real origin, which is the isolation this whole
          // feature rests on. `allow-popups` only lets a `target=_blank` link
          // reach main, which opens it in the browser and makes no window.
          sandbox="allow-scripts allow-popups"
          // Hidden until its document has loaded, then faded in: a frame paints
          // whatever it has as it goes, and an app half-styled for a frame or
          // two reads as a glitch. A reload or a mode change starts it over.
          onLoad={(event) => {
            if (live.current && event.currentTarget === frameRef.current) setLoaded(path)
          }}
          className={cn(
            'min-h-0 flex-1 border-0',
            loaded !== null ? 'motion-in-fade' : 'opacity-0',
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
      <figcaption>In the developer&rsquo;s words:</figcaption>
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
 *  could tell their login; the hash opens the bundle's history at that commit, the dialog a
 *  document's History opens. A personal app never committed was written on
 *  this machine. */
function WrittenBy({
  path,
  authorship,
}: {
  path: string
  authorship: Authorship
}): React.JSX.Element {
  const { added, last } = authorship
  // The commit the history opens on, kept after closing so the dialog can
  // animate out. A closed dialog asks git and GitHub nothing.
  const [historyAt, setHistoryAt] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const openAt = (sha: string) => {
    setHistoryAt(sha)
    setHistoryOpen(true)
  }
  return (
    <div className="grid gap-1.5 rounded-xl bg-muted/60 px-4 py-3 text-xs text-muted-foreground">
      {added == null ? (
        <span>Not committed yet: written on this machine.</span>
      ) : (
        <>
          <CommitLine lead="Added by" commit={added} onOpen={() => openAt(added.sha)} />
          {last != null && last.sha !== added.sha && (
            <CommitLine lead="Last changed by" commit={last} onOpen={() => openAt(last.sha)} />
          )}
          {historyAt !== null && (
            <FileHistoryDialog
              path={path}
              sha={historyAt}
              open={historyOpen}
              onOpenChange={setHistoryOpen}
            />
          )}
        </>
      )}
    </div>
  )
}

function CommitLine({
  lead,
  commit,
  onOpen,
}: {
  lead: string
  commit: AppCommit
  onOpen: () => void
}): React.JSX.Element {
  const link = '-mx-2 text-xs text-foreground'
  return (
    <span className="min-w-0">
      {lead}{' '}
      {commit.login === null ? (
        <span className="text-foreground">{commit.author}</span>
      ) : (
        <Button
          variant="link"
          className={link}
          onClick={() => openExternal(`https://github.com/${commit.login}`)}
        >
          {commit.author}
        </Button>
      )}{' '}
      in{' '}
      <Button variant="link" className={cn(link, 'font-mono')} onClick={onOpen}>
        {commit.sha.slice(0, 7)}
      </Button>
      , {day(commit.date)}
    </span>
  )
}
