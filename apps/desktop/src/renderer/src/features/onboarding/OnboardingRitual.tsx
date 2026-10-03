import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { X } from 'lucide-react'
import type { Repo } from '../../../../main/github/api'
import {
  Button,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
} from '@/primitives'
import { trpc } from '@/lib/trpc'
import { sessionAtom } from '@/state/session'
import {
  activeRemoteAtom,
  addVaultAtom,
  createVaultAtom,
  loadVaultsAtom,
  vaultsAtom,
} from '@/state/vaults'
import {
  canAdvance,
  initialState,
  reduce,
  slugify,
  startingAct,
  type Act,
  type Mode,
} from '@/state/onboarding-flow'
import {
  VAULT_SETTING_DEFAULTS,
  enabledPlugins,
  splitAnswersByTarget,
  type PluginSettings,
} from '@holi/shared'
import { installedPluginsAtom } from '@/state/plugins'
import { PluginsAct } from './PluginsAct'
import { VaultSettingsAct } from './VaultSettingsAct'
import './onboarding-ritual.css'

type DotState = 'pending' | 'active' | 'done'
type ActState = 'idle' | 'active' | 'exiting'

// The ceremony CTAs come in two weights: the solid pill (Button `ceremony`) and
// a transparent ghost. The ghost reuses the stock `ghost` variant and layers on
// the ceremony geometry, kept here as one shared string.
const CEREMONY_GHOST =
  'h-[38px] gap-2 rounded-full px-5 text-[13px] font-medium tracking-[0.005em] text-muted-foreground hover:text-foreground'

interface Props {
  /** `first-run` plays every act from the greeting; `add-vault` skips the
   *  greeting and starts at naming. */
  mode: Mode
  /** Only provided in `add-vault` mode. The × button + Esc-at-the-floor call
   *  this to dismiss the overlay. Absent in `first-run`: nowhere to dismiss to. */
  onDismiss?: () => void
  /**
   * Walk the whole ritual against nothing (Developer → Test onboarding).
   *
   * **Creates nothing and writes nothing**: no GitHub repo, no clone, no vault
   * in the registry, no settings files. The naming act fakes its own success so
   * the settings act and the threshold, otherwise unreachable until a vault is
   * created, can be driven.
   */
  dryRun?: boolean
}

export function OnboardingRitual({ mode, onDismiss, dryRun = false }: Props) {
  const session = useAtomValue(sessionAtom)
  const installed = useAtomValue(installedPluginsAtom)
  const known = useAtomValue(vaultsAtom)
  const createVault = useSetAtom(createVaultAtom)
  const addVault = useSetAtom(addVaultAtom)
  const setActiveRemote = useSetAtom(activeRemoteAtom)
  const loadVaults = useSetAtom(loadVaultsAtom)

  const [s, dispatch] = useReducer(reduce, undefined, () =>
    initialState(mode, session?.login ?? ''),
  )

  // Purely visual crossfade bookkeeping: which act is fading out. Kept out of
  // the reducer, which owns the logical flow.
  const [exitingAct, setExitingAct] = useState<Act | null>(null)
  const [continueWokenOnce, setContinueWokenOnce] = useState(false)
  const [continueWaking, setContinueWaking] = useState(false)

  const [orgs, setOrgs] = useState<string[]>([])
  const [repos, setRepos] = useState<Repo[] | null>(null)
  /** Non-null when the repo list failed to load: kept local to the join view
   *  (with a retry) rather than aborting the whole ritual. */
  const [reposError, setReposError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  /** The `owner/repo` of the vault just created, so the threshold can show and
   *  copy the live remote. */
  const [createdRemote, setCreatedRemote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const nameRef = useRef<HTMLInputElement>(null)

  const slug = slugify(s.name)

  // `read:org` buys exactly one feature: offering an org as the owner of a new
  // vault. If it fails, the personal account still works.
  useEffect(() => {
    void trpc.github.orgs
      .query()
      .then((list) => setOrgs(list.map((o) => o.login)))
      .catch(() => {})
  }, [])

  // Load the repo list for the join picker. A failure stays *here*, shown in
  // the picker with a retry, rather than losing the user's place.
  const loadRepos = useCallback(() => {
    setReposError(null)
    void trpc.github.repos
      .query()
      .then(setRepos)
      .catch((err: unknown) => setReposError(err instanceof Error ? err.message : String(err)))
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
    // The threshold is terminal: the vault already exists, so only "Open vault"
    // forward. The settings act before it is NOT terminal.
    if (s.act === 5) return
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

  /**
   * Save the settings act's answers, then move on to the threshold.
   *
   * The vault already exists and its settings files hold the seed's defaults,
   * so this MERGES the answers over them, which is why a failure is not fatal:
   * the vault still has valid settings. Surface it and carry on.
   *
   * The split is by each descriptor's own `target`, so a new setting reaches
   * the right file without this function changing.
   */
  const saveSettings = async () => {
    const remote = createdRemote
    if (remote === null) {
      advance()
      return
    }
    // A dry run has no vault to write to.
    if (dryRun) {
      advance()
      return
    }
    // The plugins answer is written as a patch is: a plugin id to on or off,
    // for the ones turned away from their default. The resolved shape the act
    // keeps (`vault` and `localOff`) is what a read returns, not what a write
    // takes.
    const answers = { ...s.settings, plugins: plugins.vault }
    const { committed, local } = splitAnswersByTarget(answers)
    try {
      const { warnings } = await trpc.settings.write.mutate({
        remote,
        committedJson: JSON.stringify(committed),
        localJson: JSON.stringify(local),
      })
      // A refused value is not an error the ritual can act on, but it must not
      // vanish either.
      if (warnings.length > 0) console.warn(`[settings] ${warnings.join('; ')}`)
    } catch (err) {
      console.warn(
        `[settings] could not save your choices: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    advance()
  }

  // Create the vault from the naming act. On success the repo exists and is
  // pushed (the router commits and pushes before returning). On failure we stay
  // on the naming form with the message shown.
  const submit = async () => {
    if (s.submitting || !canAdvance(s)) return
    // The fake success a dry run turns on: everything downstream reads
    // `createdRemote`, so setting it makes the rest of the ritual reachable.
    if (dryRun) {
      setCreatedRemote(`${s.owner || 'you'}/${slug}`)
      runExit(2)
      dispatch({ type: 'created' })
      return
    }
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

  // "Open vault" on the threshold: activate, refresh the list (which flips the
  // first-run gate to the Shell), and dismiss the add-vault popover if open.
  const enter = async () => {
    // A dry run has no new vault to refresh into, so it only closes.
    if (dryRun) {
      onDismiss?.()
      return
    }
    // **Activate here, not at creation.** Activating makes the Shell land the
    // vault and read its settings; doing it at the naming act would read the
    // seeded defaults before the settings act's answers were written. A joined
    // vault activates itself (`addVaultAtom`) and never reaches this act.
    if (createdRemote !== null) setActiveRemote(createdRemote)
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
  // the message shown. Success unmounts us via the App gate / Shell refresh.
  const run = (fn: () => Promise<unknown>) => {
    dispatch({ type: 'submitStart' })
    return fn().catch((err: unknown) =>
      dispatch({ type: 'failInPlace', error: err instanceof Error ? err.message : String(err) }),
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
        if (s.act === 5) void enter()
        else if (s.act === 4) void saveSettings()
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

  const plugins =
    (s.settings.plugins as PluginSettings | undefined) ?? VAULT_SETTING_DEFAULTS.plugins
  const running = enabledPlugins(
    plugins,
    installed.map((p) => p.info),
  )

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
              <span className="obrit-rule" />
              <span className="obrit-dot" data-state={dotState(4)} />
              <span className="obrit-rule" />
              <span className="obrit-dot" data-state={dotState(5)} />
            </div>
            {dismissible && (
              <IconButton
                icon={X}
                label="Dismiss"
                tooltip="Dismiss (Esc)"
                size="md"
                shape="round"
                onClick={onDismiss}
              />
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
                  Notes, tasks, mail, calendar, and an agent that listens. All in a vault you own,
                  synced to a repo you control.
                </p>
                <div className="obrit-cta-row">
                  <Button variant="ceremony" onClick={advance}>
                    Begin
                    <span aria-hidden>→</span>
                  </Button>
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
                    <Input
                      ref={nameRef}
                      variant="display"
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
                      github.com/{s.owner || '…'}/
                      <span className="obrit-slug-out">{slug || '…'}</span> · private
                    </div>
                  </div>

                  <div className="obrit-form">
                    <div className="obrit-field">
                      <div className="obrit-field-label">OWNER</div>
                      <Select
                        value={s.owner}
                        onValueChange={(owner) => dispatch({ type: 'setOwner', owner })}
                      >
                        <SelectTrigger variant="underline">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ownerOptions.map((o) => (
                            <SelectItem key={o} value={o}>
                              {o}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="obrit-field-caption">
                        the account or org this private repo is created under.
                      </div>
                    </div>
                    <div className="obrit-cta-row">
                      <Button
                        variant="ghost"
                        className={CEREMONY_GHOST}
                        onClick={() => dispatch({ type: 'toJoin' })}
                      >
                        <span aria-hidden>↳</span>
                        join one you've been added to
                      </Button>
                    </div>
                    {s.error && <div className="obrit-error">{s.error}</div>}
                  </div>
                </>
              ) : (
                <div className="obrit-name-stage obrit-join">
                  <div className="obrit-eyebrow">JOIN A VAULT</div>
                  <Input
                    autoFocus
                    variant="underline"
                    className="font-mono text-[13.5px]"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="search your repos…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="obrit-join-list">
                    {repos === null && reposError === null && (
                      <p className="obrit-field-caption">loading repos…</p>
                    )}
                    {reposError !== null && (
                      <div className="obrit-join-error">
                        <p className="obrit-field-caption is-warn">couldn't load your repos.</p>
                        <Button variant="ghost" className={CEREMONY_GHOST} onClick={loadRepos}>
                          retry
                        </Button>
                      </div>
                    )}
                    {repos !== null &&
                      matches.map((repo) => (
                        <Button
                          key={repo.remote}
                          variant="ghost"
                          disabled={s.submitting || !repo.canPush}
                          className="h-auto w-full justify-start gap-2.5 rounded-md px-2.5 py-2 font-mono text-[13px] font-normal text-foreground"
                          onClick={() => run(() => addVault(repo.remote))}
                          // `title` is a Button *prop*, not a native attribute, so the
                          // native-title ban doesn't apply. The Radix Tooltip never fires
                          // on a disabled trigger, so the plain title explains it.
                          title={repo.canPush ? '' : 'you cannot push to this repo'}
                        >
                          <span className="obrit-join-remote">{repo.remote}</span>
                          {repo.visibility !== 'private' && (
                            <span className="obrit-join-vis">{repo.visibility}</span>
                          )}
                        </Button>
                      ))}
                    {repos !== null && matches.length === 0 && (
                      <p className="obrit-field-caption">no repos match</p>
                    )}
                  </div>
                  <div className="obrit-cta-row">
                    <Button
                      variant="ghost"
                      className={CEREMONY_GHOST}
                      onClick={() => dispatch({ type: 'toForm' })}
                    >
                      <span aria-hidden>←</span>
                      back
                    </Button>
                  </div>
                  {s.error && <div className="obrit-error">{s.error}</div>}
                </div>
              )}
            </div>
          </section>

          {/* ── Act 3: What this vault runs ── */}
          {/* Chosen once, at birth: see `PluginsAct`. */}
          <section
            className="obrit-act obrit-settings-act obrit-plugins-act"
            data-state={actState(3)}
          >
            <div className="obrit-act-inner">
              <div className="obrit-eyebrow">WHAT THIS VAULT RUNS</div>
              <p className="obrit-lede">
                Notes, tasks and sync are always there. These come on top.
              </p>

              <PluginsAct
                plugins={plugins}
                onChange={(info, on) =>
                  dispatch({ type: 'setPlugin', id: info.id, on, byDefault: info.default })
                }
              />
              <p className="obrit-settings-where">
                Everyone who clones this vault gets the same plugins. Any of them can be turned off
                on one machine, in Settings.
              </p>
            </div>
          </section>

          {/* ── Act 4: How this vault behaves ── */}
          {/* Asked once, at birth: see `VaultSettingsAct`. */}
          <section className="obrit-act obrit-settings-act" data-state={actState(4)}>
            <div className="obrit-act-inner">
              <div className="obrit-eyebrow">A FEW CHOICES</div>
              <p className="obrit-lede">All of them have sensible answers already.</p>

              <VaultSettingsAct
                settings={s.settings}
                onChange={(key, value) => dispatch({ type: 'setSetting', key, value })}
              />
            </div>
          </section>

          {/* ── Act 5: Threshold ── */}
          <section className="obrit-act obrit-threshold" data-state={actState(5)}>
            <div className="obrit-act-inner">
              <div className="obrit-thresh-rule" />
              <div className="obrit-eyebrow">YOUR VAULT IS READY</div>
              <h1 className="obrit-display">
                Welcome to <span className="obrit-vault-name">{slug || '…'}</span>.
              </h1>
              <p className="obrit-lede">Created under {s.owner} · your team can clone it now.</p>

              {createdRemote && (
                <Tooltip content="copy the repo URL">
                  <Button
                    variant="ghost"
                    className="mt-6 h-auto gap-4 rounded-[9px] border border-border px-4 py-2.5 font-normal hover:border-primary/50"
                    onClick={copyRemote}
                  >
                    <span className="obrit-repo-url-text">github.com/{createdRemote}</span>
                    <span className="obrit-repo-url-copy">{copied ? 'copied ✓' : '⧉ copy'}</span>
                  </Button>
                </Tooltip>
              )}

              <div className="obrit-cta-row">
                <Button variant="ceremony" onClick={() => void enter()}>
                  Open vault
                  <span aria-hidden>→</span>
                </Button>
              </div>

              <div className="obrit-hotkeys">
                <div className="obrit-hotkey">
                  <kbd className="obrit-kbd">⌘P</kbd>
                  <span className="obrit-hotkey-label">command palette</span>
                </div>
                <div className="obrit-hotkey">
                  <kbd className="obrit-kbd">⌘T</kbd>
                  <span className="obrit-hotkey-label">tasks</span>
                </div>
                {/* Mail is Google's: no hint for a key that opens nothing. */}
                {running.has('google') && (
                  <div className="obrit-hotkey">
                    <kbd className="obrit-kbd">⌘M</kbd>
                    <span className="obrit-hotkey-label">mail</span>
                  </div>
                )}
              </div>

              {s.error && <div className="obrit-error">{s.error}</div>}
            </div>
          </section>
        </div>

        <footer className="obrit-foot">
          <div className="obrit-foot-side">
            {s.view === 'form' && s.act !== 5 && (s.act > startingAct(mode) || dismissible) && (
              <Button variant="ghost" className={CEREMONY_GHOST} onClick={back}>
                <span aria-hidden>←</span>
                {s.act > startingAct(mode) ? 'back' : 'dismiss'}
              </Button>
            )}
          </div>
          <div className="obrit-foot-side is-right">
            {s.act === 3 && (
              <Button variant="ceremony" onClick={advance}>
                Continue
                <span aria-hidden>→</span>
              </Button>
            )}
            {s.act === 4 && (
              <Button variant="ceremony" onClick={() => void saveSettings()}>
                Continue
                <span aria-hidden>→</span>
              </Button>
            )}
            {s.act === 2 && s.view === 'form' && (
              <>
                {!s.submitting && (
                  <span className="obrit-keyhint">
                    press <span className="obrit-kbd-inline">enter</span>
                  </span>
                )}
                <Button
                  variant="ceremony"
                  className={continueWaking ? 'obrit-wake' : ''}
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
                </Button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
