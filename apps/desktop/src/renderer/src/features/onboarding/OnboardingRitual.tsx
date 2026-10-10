/**
 * The onboarding ritual: the frame and the flow, with each act its own
 * component. The acts are `ACTS` in the reducer; this file shows the one that
 * is current, crossfades between them, and owns the keys and the footer, which
 * both run the current act's primary action.
 */
import { useEffect, useReducer, useState } from 'react'
import { useAtomValue } from 'jotai'
import { X } from 'lucide-react'
import { VAULT_SETTING_DEFAULTS, resolvePlugins, type PluginSettings } from '@holi/shared'
import { Button, IconButton } from '@/primitives'
import {
  actIndex,
  actsFor,
  canAdvance,
  initialState,
  reduce,
  slugify,
  startingAct,
  type Act,
  type Mode,
} from '@/state/onboarding-flow'
import { installedPluginsAtom } from '@/state/plugins'
import { sessionAtom } from '@/state/session'
import { useRitualActions } from './actions'
import { CEREMONY_GHOST } from './ceremony'
import { GreetingAct } from './GreetingAct'
import { JoinPicker } from './JoinPicker'
import { NamingAct } from './NamingAct'
import { PluginsAct } from './PluginsAct'
import { ThresholdAct } from './ThresholdAct'
import { VaultSettingsAct } from './VaultSettingsAct'
import './onboarding-ritual.css'

type ActState = 'idle' | 'active' | 'exiting'

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
   * **Creates nothing and writes nothing**: the ritual runs on the dry set of
   * actions (`actions.ts`), whose create fakes its own success so the acts
   * after naming, otherwise unreachable until a vault exists, can be driven.
   */
  dryRun?: boolean
}

/** What the footer's right-hand button does on an act, and what Enter does. */
interface Primary {
  label: string
  run: () => void
  disabled?: boolean
}

export function OnboardingRitual({ mode, onDismiss, dryRun = false }: Props) {
  const session = useAtomValue(sessionAtom)
  const installed = useAtomValue(installedPluginsAtom)
  const actions = useRitualActions(dryRun, onDismiss)

  const [s, dispatch] = useReducer(reduce, undefined, () =>
    initialState(mode, session?.login ?? ''),
  )

  // Purely visual crossfade bookkeeping: which act is fading out. Kept out of
  // the reducer, which owns the logical flow.
  const [exitingAct, setExitingAct] = useState<Act | null>(null)
  // The one-time awakening of "create vault", the first time a valid name
  // appears.
  const [wokenOnce, setWokenOnce] = useState(false)
  const [waking, setWaking] = useState(false)
  /** The `owner/repo` of the vault just created. */
  const [createdRemote, setCreatedRemote] = useState<string | null>(null)

  const slug = slugify(s.name)
  const naming = s.act === 'naming' && s.view === 'form'
  const plugins =
    (s.settings.plugins as PluginSettings | undefined) ?? VAULT_SETTING_DEFAULTS.plugins
  const { running } = resolvePlugins(
    plugins,
    installed.map((p) => p.info),
  )

  useEffect(() => {
    if (!naming || !slug || wokenOnce) return
    setWokenOnce(true)
    setWaking(true)
    const t = setTimeout(() => setWaking(false), 1200)
    return () => clearTimeout(t)
  }, [naming, slug, wokenOnce])

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
    // The threshold is terminal: the vault exists, so only "Open vault" forward.
    if (s.act === 'threshold') return
    if (s.view === 'join') {
      dispatch({ type: 'toForm' })
      return
    }
    if (s.act !== startingAct(mode)) {
      runExit(s.act)
      dispatch({ type: 'back', mode })
      return
    }
    onDismiss?.()
  }

  /** Errors stay where they happened, with the message shown. */
  const failInPlace = (err: unknown) =>
    dispatch({ type: 'failInPlace', error: err instanceof Error ? err.message : String(err) })

  const create = async () => {
    if (s.submitting || !canAdvance(s)) return
    dispatch({ type: 'submitStart' })
    try {
      setCreatedRemote(await actions.create({ name: slug, owner: s.owner }))
      runExit('naming')
      dispatch({ type: 'created' })
    } catch (err) {
      failInPlace(err)
    }
  }

  const join = (remote: string) => {
    dispatch({ type: 'submitStart' })
    // Success unmounts the ritual through the App gate.
    actions.join(remote).catch(failInPlace)
  }

  const saveAnswers = async () => {
    if (createdRemote !== null) await actions.saveAnswers(createdRemote, s.settings)
    advance()
  }

  const open = () => void actions.open(createdRemote)

  const primary: Partial<Record<Act, Primary>> = {
    ...(naming && {
      naming: {
        label: s.submitting ? 'creating…' : 'create vault',
        run: () => void create(),
        disabled: !slug || s.submitting,
      },
    }),
    plugins: { label: 'Continue', run: advance },
    settings: { label: 'Continue', run: () => void saveAnswers() },
  }

  // Space begins from the greeting; Enter runs the act's primary action (or
  // opens the vault from the threshold); Esc walks back and finally dismisses.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inField = e.target instanceof HTMLInputElement
      if (e.key === 'Escape') {
        e.preventDefault()
        back()
      } else if (e.key === ' ' && !inField && s.act === 'greeting') {
        e.preventDefault()
        advance()
      } else if (e.key === 'Enter' && (!inField || s.act === 'naming')) {
        const act = primary[s.act]
        if (s.act === 'threshold') open()
        else if (s.act === 'greeting') advance()
        else if (act !== undefined && !act.disabled) act.run()
        else return
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, mode, slug, createdRemote])

  const acts = actsFor(mode)
  const current = actIndex(s.act)
  const stateOf = (act: Act): ActState =>
    act === s.act ? 'active' : act === exitingAct ? 'exiting' : 'idle'
  const dismissible = mode === 'add-vault' && onDismiss != null
  const footPrimary = primary[s.act]
  const atFloor = s.act === startingAct(mode)

  const section = (act: Act, className: string, children: React.ReactNode) => (
    <section className={`obrit-act ${className}`} data-act={act} data-state={stateOf(act)}>
      <div className="obrit-act-inner">{children}</div>
    </section>
  )

  return (
    <div className="onboarding-ritual" role="dialog" aria-modal="true">
      <div className="obrit-frame">
        <header className="obrit-head">
          <div className="obrit-mark">H</div>
          <div className="obrit-head-right">
            <div className="obrit-steps">
              {acts.map((act, i) => (
                <span key={act} className="obrit-step">
                  {i > 0 && <span className="obrit-rule" />}
                  <span
                    className="obrit-dot"
                    data-state={
                      actIndex(act) < current ? 'done' : act === s.act ? 'active' : 'pending'
                    }
                  />
                </span>
              ))}
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
          {mode === 'first-run' &&
            section('greeting', 'obrit-greeting', <GreetingAct onBegin={advance} />)}

          {section(
            'naming',
            'obrit-name',
            s.view === 'form' ? (
              <NamingAct
                name={s.name}
                owner={s.owner}
                slug={slug}
                error={s.error}
                active={naming}
                onName={(name) => dispatch({ type: 'setName', name })}
                onOwner={(owner) => dispatch({ type: 'setOwner', owner })}
                onJoin={() => dispatch({ type: 'toJoin' })}
              />
            ) : (
              <JoinPicker
                submitting={s.submitting}
                error={s.error}
                onPick={join}
                onBack={() => dispatch({ type: 'toForm' })}
              />
            ),
          )}

          {section(
            'plugins',
            'obrit-settings-act',
            <>
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
            </>,
          )}

          {section(
            'settings',
            'obrit-settings-act',
            <>
              <div className="obrit-eyebrow">A FEW CHOICES</div>
              <p className="obrit-lede">All of them have sensible answers already.</p>
              <VaultSettingsAct
                settings={s.settings}
                onChange={(key, value) => dispatch({ type: 'setSetting', key, value })}
              />
            </>,
          )}

          {section(
            'threshold',
            'obrit-threshold',
            <ThresholdAct
              slug={slug}
              owner={s.owner}
              remote={createdRemote}
              running={running}
              error={s.error}
              onOpen={open}
            />,
          )}
        </div>

        <footer className="obrit-foot">
          <div className="obrit-foot-side">
            {s.view === 'form' && s.act !== 'threshold' && (!atFloor || dismissible) && (
              <Button variant="ghost" className={CEREMONY_GHOST} onClick={back}>
                <span aria-hidden>←</span>
                {atFloor ? 'dismiss' : 'back'}
              </Button>
            )}
          </div>
          <div className="obrit-foot-side is-right">
            {s.act === 'naming' && naming && !s.submitting && (
              <span className="obrit-keyhint">
                press <span className="obrit-kbd-inline">enter</span>
              </span>
            )}
            {footPrimary !== undefined && (
              <Button
                variant="ceremony"
                className={s.act === 'naming' && waking ? 'obrit-wake' : ''}
                onClick={footPrimary.run}
                disabled={footPrimary.disabled}
              >
                {footPrimary.label}
                {!(s.act === 'naming' && s.submitting) && <span aria-hidden>→</span>}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
