/**
 * The onboarding ritual: the frame and the flow, with each act its own
 * component. The acts are `ACTS` in the reducer; this file mounts the one that
 * is current (its fade in is the view's one entrance) and owns the keys and
 * the footer, which both run the current act's primary action.
 */
import { useEffect, useReducer, useState } from 'react'
import { useAtomValue } from 'jotai'
import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react'
import { VAULT_SETTING_DEFAULTS, resolvePlugins, type PluginSettings } from '@holi/shared'
import { BrandMark } from '@/composites'
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
import {
  actsFor,
  canAdvance,
  initialState,
  reduce,
  vaultSlug,
  startingAct,
  type Act,
  type Mode,
} from '@/state/onboarding-flow'
import { installedPluginsAtom } from '@/state/plugins'
import { sessionAtom } from '@/state/session'
import { useRitualActions } from './actions'
import { GreetingAct } from './GreetingAct'
import { JoinPicker } from './JoinPicker'
import { NamingAct } from './NamingAct'
import { PluginsAct } from './PluginsAct'
import { ThresholdAct } from './ThresholdAct'
import { ActHeading } from './ActHeading'
import { VaultSettingsAct } from './VaultSettingsAct'

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

  /** The `owner/repo` of the vault just created. */
  const [createdRemote, setCreatedRemote] = useState<string | null>(null)
  /** How far the build on the threshold has got: the repo, then the answers. */
  const [built, setBuilt] = useState(0)

  const slug = vaultSlug(s.name)
  const naming = s.act === 'naming' && s.view === 'form'
  const plugins =
    (s.settings.plugins as PluginSettings | undefined) ?? VAULT_SETTING_DEFAULTS.plugins
  const { running } = resolvePlugins(
    plugins,
    installed.map((p) => p.info),
  )

  const advance = () => {
    if (!canAdvance(s)) return
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
    dispatch({ type: 'advance' })
    dispatch({ type: 'submitStart' })
    setBuilt(0)
    let remote: string
    try {
      ;[remote] = await Promise.all([actions.create({ name: slug, owner: s.owner }), beat()])
    } catch (err) {
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

  const open = () => void actions.open(createdRemote)

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
  const dismissible = mode === 'add-vault' && onDismiss != null
  const footPrimary = primary[s.act]
  const atFloor = s.act === startingAct(mode)

  const act = (() => {
    switch (s.act) {
      case 'greeting':
        return <GreetingAct onBegin={advance} />
      case 'naming':
        return s.view === 'form' ? (
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
        )
      case 'plugins':
        return (
          <>
            <ActHeading
              title="What this vault runs"
              description="Notes, tasks and sync are always there. These come on top."
            />
            <PluginsAct
              plugins={plugins}
              onChange={(info, on) =>
                dispatch({ type: 'setPlugin', id: info.id, on, byDefault: info.default })
              }
            />
            <p className="text-xs text-muted-foreground">
              Everyone who clones this vault gets the same plugins. Any of them can be turned off on
              one machine, in Settings.
            </p>
          </>
        )
      case 'settings':
        return (
          <>
            <ActHeading
              title="A few choices"
              description="All of them have sensible answers already."
            />
            <VaultSettingsAct
              settings={s.settings}
              onChange={(key, value) => dispatch({ type: 'setSetting', key, value })}
            />
          </>
        )
      case 'threshold':
        return (
          <ThresholdAct
            slug={slug}
            owner={s.owner}
            remote={createdRemote}
            running={running}
            building={s.submitting}
            built={built}
            error={s.error}
            onOpen={open}
          />
        )
    }
  })()

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background text-sm text-foreground"
      role="dialog"
      aria-modal="true"
      aria-label="Set up a vault"
    >
      <header className="flex shrink-0 items-center justify-between px-6 py-5">
        <BrandMark />
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
      </header>

      {/* Joining clones a vault that already has its plugins and choices, so
          there are no steps to count while the join list is up. */}
      <RitualSteps acts={acts} current={s.act} hidden={s.view === 'join'} />

      <main className="min-h-0 flex-1 overflow-y-auto">
        {/* Only the act on screen is mounted, so nothing of another act can be
            reached by Tab: the greeting's Begin, pressed from naming, would
            skip creating the vault. Keyed, so each act fades in once. */}
        <section
          key={`${s.act}:${s.view}`}
          data-act={s.act}
          className={`mx-auto flex min-h-full w-full flex-col justify-center gap-6 px-6 py-8 motion-in-fade ${
            s.act === 'plugins' || s.act === 'settings' ? 'max-w-2xl' : 'max-w-xl'
          }`}
        >
          {act}
        </section>
      </main>

      <footer className="flex shrink-0 items-center justify-between gap-3 px-6 py-5">
        <div className="flex items-center gap-2">
          {s.view === 'form' && s.act !== 'threshold' && (!atFloor || dismissible) && (
            <Button variant="ghost" onClick={back}>
              <Icon icon={ArrowLeft} size="sm" />
              {atFloor ? 'Dismiss' : 'Back'}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {s.act === 'naming' && naming && !s.submitting && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Press <Kbd>Enter</Kbd>
            </span>
          )}
          {footPrimary !== undefined && (
            <Button onClick={footPrimary.run} disabled={footPrimary.disabled}>
              {footPrimary.label}
              <Icon icon={ArrowRight} size="sm" />
            </Button>
          )}
        </div>
      </footer>
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
 * Where the ritual is, above the act: a numbered step per act with its name,
 * ticked once done (ReUI's `stepper`). It counts only the acts that ask
 * something (`STEPPED`): the greeting is the door in and the threshold is the
 * result, so on those it is not shown. Progress only: the acts are gated by
 * what each one needs, so there are no triggers and nothing here reads as a
 * way to jump ahead.
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
  if (!STEPPED.has(current) || hidden) return null
  const at = steps.indexOf(current) + 1
  return (
    <div className="flex shrink-0 justify-center px-6 pb-2">
      <Stepper
        value={at}
        indicators={{ completed: <Icon icon={Check} size="sm" /> }}
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuenow={at}
        aria-valuetext={`Step ${at} of ${steps.length}: ${STEP_TITLES[current] ?? ''}`}
        className="max-w-md"
      >
        <StepperNav>
          {steps.map((act, i) => (
            <StepperItem key={act} step={i + 1}>
              <div className="flex items-center gap-2">
                <StepperIndicator>{i + 1}</StepperIndicator>
                <StepperTitle className="data-[state=inactive]:text-muted-foreground">
                  {STEP_TITLES[act]}
                </StepperTitle>
              </div>
              {i < steps.length - 1 && <StepperSeparator className="mx-3" />}
            </StepperItem>
          ))}
        </StepperNav>
      </Stepper>
    </div>
  )
}
