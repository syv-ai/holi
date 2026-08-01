import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { Repo } from '../../../main/github/api'
import { Tooltip } from '@/primitives'
import { trpc } from '../lib/trpc'
import { sessionAtom } from '../state/session'
import { addVaultAtom, createVaultAtom, loadVaultsAtom, vaultsAtom } from '../state/vaults'
import {
  atFloor,
  canAdvance,
  initialState,
  reduce,
  slugify,
  startingAct,
  type Act,
  type Mode
} from '../state/onboarding-flow'
import '../styles/onboarding-ritual.css'

type DotState = 'pending' | 'active' | 'done'
type ActState = 'idle' | 'active' | 'exiting'

interface Props {
  /** `first-run` plays all three acts (greeting → naming → threshold);
   *  `add-vault` skips the greeting and starts at naming. */
  mode: Mode
  /** Only provided in `add-vault` mode. The × button + Esc-at-the-floor call
   *  this to dismiss the overlay. Absent in `first-run` — nowhere to dismiss to. */
  onDismiss?: () => void
}

export function OnboardingRitual({ mode, onDismiss }: Props) {
  const session = useAtomValue(sessionAtom)
  const known = useAtomValue(vaultsAtom)
  const createVault = useSetAtom(createVaultAtom)
  const addVault = useSetAtom(addVaultAtom)
  const loadVaults = useSetAtom(loadVaultsAtom)

  const [s, dispatch] = useReducer(reduce, undefined, () =>
    initialState(mode, session?.login ?? '')
  )

  // Purely visual crossfade bookkeeping — which act is fading out. Kept local
  // because it has nothing to do with the logical flow the reducer owns.
  const [exitingAct, setExitingAct] = useState<Act | null>(null)
  const [continueWokenOnce, setContinueWokenOnce] = useState(false)
  const [continueWaking, setContinueWaking] = useState(false)

  const [orgs, setOrgs] = useState<string[]>([])
  const [repos, setRepos] = useState<Repo[] | null>(null)
  /** Non-null when the repo list failed to load — kept local to the join view
   *  (with a retry) rather than aborting the whole ritual. */
  const [reposError, setReposError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  /** The `owner/repo` of the vault just created — set on success so the
   *  threshold can show and copy the live remote. */
  const [createdRemote, setCreatedRemote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const nameRef = useRef<HTMLInputElement>(null)

  const slug = slugify(s.name)

  // FR-3: `read:org` buys exactly one feature — offering an org as the owner of
  // a new vault. If it fails, the personal account still works.
  useEffect(() => {
    void trpc.github.orgs
      .query()
      .then((list) => setOrgs(list.map((o) => o.login)))
      .catch(() => {})
  }, [])

  // Load the repo list for the join picker. A failure (a timeout, a flaky
  // network) stays *here* — shown in the picker with a retry — rather than
  // tearing down to the naming form and losing the user's place.
  const loadRepos = useCallback(() => {
    setReposError(null)
    void trpc.github.repos
      .query()
      .then(setRepos)
      .catch((err: unknown) =>
        setReposError(err instanceof Error ? err.message : String(err))
      )
  }, [])

  // Fetch the first time the join view opens, then keep it.
  useEffect(() => {
    if (s.view === 'join' && repos === null && reposError === null) loadRepos()
  }, [s.view, repos, reposError, loadRepos])

  // Auto-focus the giant input whenever Act 2's naming form becomes active.
  useEffect(() => {
    if (s.act !== 2 || s.view !== 'form') return
    const t = setTimeout(() => nameRef.current?.focus(), 220)
    return () => clearTimeout(t)
  }, [s.act, s.view])

  // The one-time continue-button awakening, the first time a valid slug appears.
  useEffect(() => {
    if (s.act !== 2 || s.view !== 'form') return
    if (!slug || continueWokenOnce) return
    setContinueWokenOnce(true)
    setContinueWaking(true)
    const t = setTimeout(() => setContinueWaking(false), 1200)
    return () => clearTimeout(t)
  }, [slug, s.act, s.view, continueWokenOnce])

  // Crossfade the outgoing act out over ~500ms.
  const runExit = (from: Act) => {
    setExitingAct(from)
    setTimeout(() => setExitingAct((cur) => (cur === from ? null : cur)), 500)
  }

  const advance = () => {
    if (!canAdvance(s)) return
    runExit(s.act)
    dispatch({ type: 'advance' })
  }

  const back = () => {
    // The threshold is terminal: the vault already exists, so there is nothing
    // to go back to — only "Open vault" forward.
    if (s.act === 3) return
    if (s.view === 'join') {
      dispatch({ type: 'toForm' })
      return
    }
    if (s.act > startingAct(mode)) {
      runExit(s.act)
      dispatch({ type: 'back', mode })
      return
    }
    // At the floor form: dismiss if we can, otherwise nothing to go back to.
    if (onDismiss) onDismiss()
  }

  // Create the vault from the naming act. On success the repo genuinely exists
  // and is pushed (the router commits + pushes before returning), so we advance
  // to the threshold, which can now say so truthfully and show the live remote.
  // On failure we stay on the naming form with the message shown.
  const submit = async () => {
    if (s.submitting || !canAdvance(s)) return
    dispatch({ type: 'submitStart' })
    try {
      const remote = await createVault({ name: slug, owner: s.owner })
      setCreatedRemote(remote)
      runExit(2)
      dispatch({ type: 'created' })
    } catch (err) {
      dispatch({ type: 'failInPlace', error: err instanceof Error ? err.message : String(err) })
    }
  }

  // "Open vault" on the threshold. The repo already exists and is active; this
  // just refreshes the list — which flips the first-run gate to the Shell — and
  // dismisses the add-vault popover if that is how we were opened.
  const enter = async () => {
    await loadVaults()
    onDismiss?.()
  }

  const copyRemote = () => {
    if (!createdRemote) return
    void navigator.clipboard.writeText(`https://github.com/${createdRemote}`).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  // Adopt a repo the user was added to. On failure we stay on the picker with
  // the message shown (a bounce to the naming form would read as an unexplained
  // reset). Success unmounts us via the App gate / Shell refresh.
  const run = (fn: () => Promise<unknown>) => {
    dispatch({ type: 'submitStart' })
    return fn().catch((err: unknown) =>
      dispatch({ type: 'failInPlace', error: err instanceof Error ? err.message : String(err) })
    )
  }

  // Keyboard choreography. Space advances from Act 1; Enter creates from the
  // naming act and enters from the threshold; Esc walks backward and ultimately
  // dismisses.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inField = e.target instanceof HTMLInputElement
      if (inField) {
        if (e.key === 'Enter' && s.act === 2 && s.view === 'form' && canAdvance(s)) {
          e.preventDefault()
          void submit()
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          back()
        }
        return
      }
      if (e.key === ' ' && s.act === 1) {
        e.preventDefault()
        advance()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (s.act === 3) void enter()
        else if (s.act === 2 && s.view === 'form') void submit()
        else advance()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        back()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, mode, slug])

  const dotState = (n: Act): DotState => {
    if (n < s.act) return 'done'
    if (n === s.act) return 'active'
    return 'pending'
  }
  const actState = (n: Act): ActState => {
    if (n === s.act) return 'active'
    if (n === exitingAct) return 'exiting'
    return 'idle'
  }

  const ownerOptions = session ? [session.login, ...orgs.filter((o) => o !== session.login)] : orgs
  const alreadyAdded = new Set(known.map((v) => v.remote))
  // Only actual vaults, not every code repo: adopting a non-vault would seed
  // Holi files into someone's codebase. Marked by the `holi-vault` topic.
  const matches = (repos ?? [])
    .filter((r) => r.isVault)
    .filter((r) => r.remote.toLowerCase().includes(search.toLowerCase()))
    .filter((r) => !alreadyAdded.has(r.remote))
    .slice(0, 40)

  const dismissible = mode === 'add-vault' && onDismiss != null
  const continueDisabled = !slug

  return (
    <div className="onboarding-ritual" role="dialog" aria-modal="true">
      <div className="obrit-vignette" />
      <div className="obrit-ember" />
      <div className="obrit-grain" />

      <div className="obrit-frame">
        <header className="obrit-head">
          <div className="obrit-mark">H</div>
          <div className="obrit-head-right">
            <div className="obrit-steps">
              <span className="obrit-dot" data-state={dotState(1)} />
              <span className="obrit-rule" />
              <span className="obrit-dot" data-state={dotState(2)} />
              <span className="obrit-rule" />
              <span className="obrit-dot" data-state={dotState(3)} />
            </div>
            {dismissible && (
              <Tooltip content="Dismiss (Esc)">
                <button type="button" className="obrit-close" onClick={onDismiss} aria-label="Dismiss">
                  ✕
                </button>
              </Tooltip>
            )}
          </div>
        </header>

        <div className="obrit-stage">
          {/* ── Act 1: Greeting (skipped in add-vault mode) ── */}
          {mode === 'first-run' && (
            <section className="obrit-act obrit-greeting" data-state={actState(1)}>
              <div className="obrit-act-inner">
                <div className="obrit-eyebrow">HOLI</div>
                <h1 className="obrit-display">Hold your thinking.</h1>
                <p className="obrit-lede">
                  Notes, tasks, mail, calendar — and an agent that listens. All in a vault you own,
                  synced to a repo you control.
                </p>
                <div className="obrit-cta-row">
                  <button type="button" className="obrit-btn" onClick={advance}>
                    Begin
                    <span aria-hidden>→</span>
                  </button>
                </div>
                <div className="obrit-keyhint">
                  <span>or press</span>
                  <span className="obrit-kbd-inline">space</span>
                </div>
              </div>
            </section>
          )}

          {/* ── Act 2: Naming (with a join overlay) ── */}
          <section className="obrit-act obrit-name" data-state={actState(2)}>
            <div className="obrit-act-inner">
              {s.view === 'form' ? (
                <>
                  <div className="obrit-name-stage">
                    <div className="obrit-eyebrow">NAME YOUR VAULT</div>
                    <input
                      ref={nameRef}
                      className="obrit-vault-input"
                      value={s.name}
                      onChange={(e) => dispatch({ type: 'setName', name: e.target.value })}
                      placeholder="your vault"
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="off"
                      maxLength={40}
                    />
                    <div className="obrit-input-underline" />
                    <div className="obrit-path-caption">
                      github.com/{s.owner || '…'}/<span className="obrit-slug-out">{slug || '…'}</span>{' '}
                      · private
                    </div>
                  </div>

                  <div className="obrit-form">
                    <div className="obrit-field">
                      <div className="obrit-field-label">OWNER</div>
                      <select
                        className="obrit-field-input"
                        value={s.owner}
                        onChange={(e) => dispatch({ type: 'setOwner', owner: e.target.value })}
                      >
                        {ownerOptions.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                      <div className="obrit-field-caption">
                        the account or org this private repo is created under.
                      </div>
                    </div>
                    <div className="obrit-cta-row">
                      <button
                        type="button"
                        className="obrit-btn is-ghost"
                        onClick={() => dispatch({ type: 'toJoin' })}
                      >
                        <span aria-hidden>↳</span>
                        join one you've been added to
                      </button>
                    </div>
                    {s.error && <div className="obrit-error">{s.error}</div>}
                  </div>
                </>
              ) : (
                <div className="obrit-name-stage obrit-join">
                  <div className="obrit-eyebrow">JOIN A VAULT</div>
                  <input
                    autoFocus
                    className="obrit-field-input is-mono"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="search your repos…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="obrit-join-list holi-scroll">
                    {repos === null && reposError === null && (
                      <p className="obrit-field-caption">loading repos…</p>
                    )}
                    {reposError !== null && (
                      <div className="obrit-join-error">
                        <p className="obrit-field-caption is-warn">couldn't load your repos.</p>
                        <button type="button" className="obrit-btn is-ghost" onClick={loadRepos}>
                          retry
                        </button>
                      </div>
                    )}
                    {repos !== null &&
                      matches.map((repo) => (
                        <button
                          key={repo.remote}
                          type="button"
                          disabled={s.submitting || !repo.canPush}
                          className="obrit-join-row"
                          onClick={() => run(() => addVault(repo.remote))}
                          // Native title, deliberately: this trigger is `disabled`,
                          // and Radix (our Tooltip) never fires on a disabled element,
                          // so the custom tooltip would vanish exactly when it explains
                          // the disabled state. The one place native title stays.
                          title={repo.canPush ? '' : 'you cannot push to this repo'}
                        >
                          <span className="obrit-join-remote">{repo.remote}</span>
                          {repo.visibility !== 'private' && (
                            <span className="obrit-join-vis">{repo.visibility}</span>
                          )}
                        </button>
                      ))}
                    {repos !== null && matches.length === 0 && (
                      <p className="obrit-field-caption">no repos match</p>
                    )}
                  </div>
                  <div className="obrit-cta-row">
                    <button
                      type="button"
                      className="obrit-btn is-ghost"
                      onClick={() => dispatch({ type: 'toForm' })}
                    >
                      <span aria-hidden>←</span>
                      back
                    </button>
                  </div>
                  {s.error && <div className="obrit-error">{s.error}</div>}
                </div>
              )}
            </div>
          </section>

          {/* ── Act 3: Threshold ── */}
          <section className="obrit-act obrit-threshold" data-state={actState(3)}>
            <div className="obrit-act-inner">
              <div className="obrit-thresh-rule" />
              <div className="obrit-eyebrow">YOUR VAULT IS READY</div>
              <h1 className="obrit-display">
                Welcome to <span className="obrit-vault-name">{slug || '…'}</span>.
              </h1>
              <p className="obrit-lede">
                Created under {s.owner} · your team can clone it now.
              </p>

              {createdRemote && (
                <Tooltip content="copy the repo URL">
                  <button type="button" className="obrit-repo-url" onClick={copyRemote}>
                    <span className="obrit-repo-url-text">github.com/{createdRemote}</span>
                    <span className="obrit-repo-url-copy">{copied ? 'copied ✓' : '⧉ copy'}</span>
                  </button>
                </Tooltip>
              )}

              <div className="obrit-cta-row">
                <button type="button" className="obrit-btn" onClick={() => void enter()}>
                  Open vault
                  <span aria-hidden>→</span>
                </button>
              </div>

              <div className="obrit-hotkeys">
                <div className="obrit-hotkey">
                  <kbd className="obrit-kbd">⌘K</kbd>
                  <span className="obrit-hotkey-label">command palette</span>
                </div>
                <div className="obrit-hotkey">
                  <kbd className="obrit-kbd">⌘T</kbd>
                  <span className="obrit-hotkey-label">tasks</span>
                </div>
                <div className="obrit-hotkey">
                  <kbd className="obrit-kbd">⌘M</kbd>
                  <span className="obrit-hotkey-label">mail</span>
                </div>
              </div>

              {s.error && <div className="obrit-error">{s.error}</div>}
            </div>
          </section>
        </div>

        <footer className="obrit-foot">
          <div className="obrit-foot-side">
            {s.view === 'form' && s.act !== 3 && (s.act > startingAct(mode) || dismissible) && (
              <button type="button" className="obrit-btn is-ghost" onClick={back}>
                <span aria-hidden>←</span>
                {s.act > startingAct(mode) ? 'back' : 'dismiss'}
              </button>
            )}
          </div>
          <div className="obrit-foot-side is-right">
            {s.act === 2 && s.view === 'form' && (
              <>
                {!s.submitting && (
                  <span className="obrit-keyhint">
                    press <span className="obrit-kbd-inline">enter</span>
                  </span>
                )}
                <button
                  type="button"
                  className={`obrit-btn ${continueWaking ? 'is-waking' : ''}`}
                  onClick={() => void submit()}
                  disabled={continueDisabled || s.submitting}
                >
                  {s.submitting ? (
                    'creating…'
                  ) : (
                    <>
                      create vault
                      <span aria-hidden>→</span>
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
