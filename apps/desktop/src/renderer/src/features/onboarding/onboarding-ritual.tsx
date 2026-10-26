/**
 * The onboarding ritual: the frame and the flow, with each act its own
 * component. The acts are `ACTS` in the reducer; this file shows the one that
 * is current, crossfades between them, and owns the keys and the footer, which
 * both run the current act's primary action.
 */
import { useEffect, useReducer, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { claudeFirstRunAtom } from '@/state/claude-first-run'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'
import { VAULT_SETTING_DEFAULTS, resolvePlugins, type PluginSettings } from '@holi/shared'
import { BrandMark } from '@/composites'
import { ScreenArcade } from '@/composites/arcade/screen-arcade'
import {
  Button,
  Icon,
  IconButton,
  Kbd,
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
} from '@/primitives'
import { cn } from '@/lib/cn'
import {
  actsFor,
  canAdvance,
  initialState,
  reduce,
  slugify,
  vaultSlug,
  startingAct,
  type Act,
  type Mode,
} from '@/state/onboarding-flow'
import { installedPluginsAtom } from '@/state/plugins'
import { sessionAtom } from '@/state/session'
import { useRitualActions } from './actions'
import { GreetingAct } from './greeting-act'
import { JoinPicker } from './join-picker'
import { NamingAct } from './naming-act'
import { PluginsAct } from './plugins-act'
import { ThresholdAct } from './threshold-act'
import { VaultSettingsAct } from './vault-settings-act'
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
   * actions (`actions.ts`), whose create fakes its own success so the build
   * and the threshold after it can be seen.
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
  /** How far the build on the threshold has got: the repo, then the answers. */
  const [built, setBuilt] = useState(0)

  const slug = vaultSlug(s.name)
  /** Only a name the user typed wakes "Create vault"; the default is there from the start. */
  const typed = slugify(s.name)
  const naming = s.act === 'naming' && s.view === 'form'
  const plugins =
    (s.settings.plugins as PluginSettings | undefined) ?? VAULT_SETTING_DEFAULTS.plugins
  const { running } = resolvePlugins(
    plugins,
    installed.map((p) => p.info),
  )

  useEffect(() => {
    if (!naming || !typed || wokenOnce) return
    setWokenOnce(true)
    setWaking(true)
    const t = setTimeout(() => setWaking(false), 1200)
    return () => clearTimeout(t)
  }, [naming, typed, wokenOnce])

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
    // The threshold is terminal: the vault exists (or is being made), so only
    // "Open vault" forward.
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

  /**
   * The one place the world changes: the repo, then the answers in it, while
   * the threshold shows each step land. Each step holds the screen for at
   * least `BUILD_BEAT`, so a fast network still reads as something being
   * made rather than a flash of a checklist. A repo that could not be made
   * goes back to naming with the reason; answers that could not be written
   * are not fatal (the seed already holds every default), as before.
   */
  const create = async () => {
    if (s.submitting) return
    runExit(s.act)
    dispatch({ type: 'advance' })
    dispatch({ type: 'submitStart' })
    setBuilt(0)
    let remote: string
    try {
      ;[remote] = await Promise.all([actions.create({ name: slug, owner: s.owner }), beat()])
    } catch (err) {
      runExit('threshold')
      dispatch({ type: 'createFailed', error: err instanceof Error ? err.message : String(err) })
      return
    }
    setCreatedRemote(remote)
    setBuilt(1)
    await Promise.all([actions.saveAnswers(remote, s.settings), beat()])
    setBuilt(2)
    await beat()
    dispatch({ type: 'created' })
  }

  const join = (remote: string) => {
    dispatch({ type: 'submitStart' })
    // Success unmounts the ritual through the App gate.
    actions.join(remote).catch(failInPlace)
  }

  const requestFirstRun = useSetAtom(claudeFirstRunAtom)
  // A new vault has never run Claude Code: the shell opens it once, so its
  // trust prompt and login come now rather than as a refused agent later.
  const open = () => {
    if (createdRemote !== null) requestFirstRun(createdRemote)
    void actions.open(createdRemote)
  }

  const primary: Partial<Record<Act, Primary>> = {
    ...(naming && { naming: { label: 'Continue', run: advance, disabled: !slug } }),
    plugins: { label: 'Continue', run: advance },
    settings: { label: 'Create vault', run: () => void create(), disabled: s.submitting },
  }

  // Space begins from the greeting; Enter runs the act's primary action (or
  // opens the vault from the threshold); Esc walks back and finally dismisses.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inField = e.target instanceof HTMLInputElement
      // A key aimed at a control or an open menu is that control's: Enter on
      // the owner switcher opens it (and must not create the vault), Escape in
      // its menu closes the menu (and must not walk back an act).
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('[role="menu"], [role="listbox"]')) return
      if (e.key !== 'Escape' && target?.closest('button, [role="switch"], [role="radio"]')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        back()
      } else if (e.key === ' ' && !inField && s.act === 'greeting') {
        e.preventDefault()
        advance()
      } else if (e.key === 'Enter' && (!inField || s.act === 'naming')) {
        const act = primary[s.act]
        if (s.act === 'threshold') {
          if (s.submitting) return
          open()
        } else if (s.act === 'greeting') advance()
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
  const stateOf = (act: Act): ActState =>
    act === s.act ? 'active' : act === exitingAct ? 'exiting' : 'idle'
  const dismissible = mode === 'add-vault' && onDismiss != null
  const footPrimary = primary[s.act]
  const atFloor = s.act === startingAct(mode)

  const section = (act: Act, className: string, children: React.ReactNode) => (
    // Every act stays mounted for the crossfade, so the ones not on screen are
    // `inert`: invisible is not enough, or Tab reaches their buttons and the
    // greeting's Begin, pressed from naming, would skip creating the vault.
    <section
      className={`obrit-act ${className}`}
      data-act={act}
      data-state={stateOf(act)}
      inert={stateOf(act) !== 'active'}
    >
      <div className="obrit-act-inner" data-arcade-keepout="">
        {children}
      </div>
    </section>
  )

  return (
    <div className="onboarding-ritual" role="dialog" aria-modal="true" data-glass-ground="">
      <ScreenArcade />
      <div className="obrit-frame">
        <header className="obrit-head app-drag">
          <BrandMark />
          <div className="obrit-head-right">
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

        {/* Joining clones a vault that already has its plugins and choices, so
            there are no steps to count while the join list is up. */}
        <RitualSteps acts={acts} current={s.act} hidden={s.view === 'join'} />

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
              building={s.submitting}
              built={built}
              error={s.error}
              onOpen={open}
            />,
          )}
        </div>

        <footer className="obrit-foot">
          <div className="obrit-foot-side">
            {s.view === 'form' && s.act !== 'threshold' && (!atFloor || dismissible) && (
              <Button variant="ghost" onClick={back}>
                <Icon icon={ArrowLeft} size="sm" />
                {atFloor ? 'Dismiss' : 'Back'}
              </Button>
            )}
          </div>
          <div className="obrit-foot-side is-right">
            {s.act === 'naming' && naming && !s.submitting && (
              <span className="obrit-keyhint">
                Press <Kbd>Enter</Kbd>
              </span>
            )}
            {footPrimary !== undefined && (
              <Button
                size="lg"
                className={cn(s.act === 'naming' && waking && 'obrit-wake')}
                onClick={footPrimary.run}
                disabled={footPrimary.disabled}
              >
                {footPrimary.label}
                <Icon icon={ArrowRight} size="sm" />
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

/** The least time each build step holds the threshold, in ms. */
const BUILD_BEAT = 700
const beat = () => new Promise<void>((done) => setTimeout(done, BUILD_BEAT))

/** The acts the stepper counts, and each one's name on it. */
const STEPPED: ReadonlySet<Act> = new Set<Act>(['naming', 'plugins', 'settings'])
const STEP_TITLES: Partial<Record<Act, string>> = {
  naming: 'Name',
  plugins: 'Plugins',
  settings: 'Choices',
}

/**
 * Where the ritual is, above the act: the step count, then a numbered step
 * per act with its name, the rule between two filling as the first is done
 * (`primitives/Stepper.tsx`). It counts only the acts that ask something
 * (`STEPPED`): the greeting is the door in and the threshold is the result,
 * so on those the stepper fades out, keeping its height so the act does not
 * jump. Progress only: the acts are gated by what each one needs, so there
 * are no triggers and nothing here reads as a way to jump ahead.
 */
function RitualSteps({
  acts,
  current,
  hidden = false,
}: {
  acts: readonly Act[]
  current: Act
  hidden?: boolean
}) {
  const steps = acts.filter((act) => STEPPED.has(act))
  const shown = STEPPED.has(current) && !hidden
  // On the threshold every step is done; on the greeting none has started.
  const at = shown ? steps.indexOf(current) + 1 : current === 'threshold' ? steps.length + 1 : 0
  return (
    <div className="obrit-progress" data-shown={shown || undefined} aria-hidden={!shown}>
      <p className="text-xs text-muted-foreground tabular-nums">
        Step {Math.min(Math.max(at, 1), steps.length)} of {steps.length}
      </p>
      <Stepper
        value={at}
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuenow={Math.min(Math.max(at, 1), steps.length)}
        aria-valuetext={`Step ${Math.min(Math.max(at, 1), steps.length)} of ${steps.length}: ${STEP_TITLES[current] ?? ''}`}
        className="w-full max-w-md"
      >
        {/* The nav is what lays the steps in a row (`primitives/Stepper.tsx`):
            without it they stack. */}
        <StepperNav>
          {steps.map((act, i) => {
            const step = i + 1
            return (
              <StepperItem key={act} step={step} className="relative flex-1 flex-col!">
                <div className="flex flex-col items-center gap-2">
                  <StepperIndicator />
                  <StepperTitle className="obrit-step-title text-xs group-data-[state=inactive]/step:text-muted-foreground">
                    {STEP_TITLES[act]}
                  </StepperTitle>
                </div>
                {step < steps.length && (
                  // From this step's dot to the next one's, filled once this
                  // step is done.
                  <StepperSeparator className="absolute start-[calc(50%+0.875rem)] top-3 m-0 w-[calc(100%-1.75rem)] -translate-y-1/2 group-data-[orientation=horizontal]/stepper-nav:flex-none data-[state=completed]:bg-foreground" />
                )}
              </StepperItem>
            )
          })}
        </StepperNav>
      </Stepper>
    </div>
  )
}
