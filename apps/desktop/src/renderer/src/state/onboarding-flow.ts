/**
 * Pure flow reducer for the first-run / add-vault onboarding ritual.
 *
 * The acts, in order, are `ACTS`; everything that walks them (advance, back,
 * the floor, the step dots) reads that list, so adding an act is adding it
 * there. `OnboardingRitual.tsx` is a thin view over this reducer, and keeping
 * the flow pure lets it be unit-tested without a DOM.
 */
import { VAULT_SETTING_DESCRIPTORS, normaliseAnswers, type PluginSettings } from '@holi/shared'

export const ACTS = ['greeting', 'naming', 'plugins', 'settings', 'threshold'] as const
export type Act = (typeof ACTS)[number]
export type View = 'form' | 'join'
export type Mode = 'first-run' | 'add-vault'

export interface OnboardingState {
  act: Act
  /** 'join' overlays the naming act with the repo picker. */
  view: View
  /** As typed; the slug is derived via `slugify`. */
  name: string
  /** GitHub login or org the vault repo is created under. */
  owner: string
  error: string | null
  submitting: boolean
  /** The settings act's answers, keyed by `VaultSettingDescriptor.key`. Seeded
   *  from the descriptors' own defaults, so clicking straight through writes
   *  exactly what the seed already wrote. */
  settings: Record<string, unknown>
}

/** lowercase, non-alnum → '-', collapse runs, trim leading/trailing '-'. */
export const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

/** 'first-run' opens on the greeting; 'add-vault' skips straight to naming. */
export const startingAct = (mode: Mode): Act => (mode === 'first-run' ? 'greeting' : 'naming')

/** Where `act` stands in the ritual, for walking it and for the step dots. */
export const actIndex = (act: Act): number => ACTS.indexOf(act)

/** The acts a mode shows, in order: add-vault has no greeting. */
export const actsFor = (mode: Mode): readonly Act[] => ACTS.slice(actIndex(startingAct(mode)))

export const initialState = (mode: Mode, owner: string): OnboardingState => ({
  act: startingAct(mode),
  view: 'form',
  name: '',
  owner,
  error: null,
  submitting: false,
  settings: Object.fromEntries(VAULT_SETTING_DESCRIPTORS.map((d) => [d.key, d.default])),
})

export const canAdvance = (s: OnboardingState): boolean => {
  if (s.act === 'naming') return slugify(s.name).length > 0
  // The plugins and settings acts always advance: every row carries a default,
  // so there is nothing to fill in and nothing to block on. The threshold is
  // the last.
  return s.act !== 'threshold'
}

/** True on the form at the starting act: the point where `back` dismisses. */
export const atFloor = (s: OnboardingState, mode: Mode): boolean =>
  s.view === 'form' && s.act === startingAct(mode)

export type Action =
  | { type: 'advance' }
  | { type: 'back'; mode: Mode }
  | { type: 'toJoin' }
  | { type: 'toForm' }
  | { type: 'setName'; name: string }
  | { type: 'setOwner'; owner: string }
  | { type: 'setSetting'; key: string; value: unknown }
  | { type: 'setPlugin'; id: string; on: boolean; byDefault: boolean }
  | { type: 'submitStart' }
  | { type: 'created' }
  | { type: 'failInPlace'; error: string }

export const reduce = (s: OnboardingState, a: Action): OnboardingState => {
  switch (a.type) {
    case 'advance': {
      if (!canAdvance(s)) return s
      return { ...s, act: ACTS[actIndex(s.act) + 1]!, error: null }
    }
    case 'back': {
      if (s.view === 'join') return { ...s, view: 'form', error: null }
      const floor = actIndex(startingAct(a.mode))
      return { ...s, act: ACTS[Math.max(floor, actIndex(s.act) - 1)]!, error: null }
    }
    case 'toJoin':
      return { ...s, view: 'join', error: null }
    case 'toForm':
      return { ...s, view: 'form' }
    case 'setName':
      return { ...s, name: a.name }
    case 'setOwner':
      return { ...s, owner: a.owner }
    case 'setSetting':
      // A fresh object rather than a mutation: the view re-renders off identity.
      // Normalised, because one answer can withdraw another's options: turning
      // daily notes off takes "today's note" off the Home row, and the value
      // sitting there becomes one the user can neither see nor change.
      return { ...s, settings: normaliseAnswers({ ...s.settings, [a.key]: a.value }) }
    case 'setPlugin': {
      // Only a plugin turned away from its own default is written down, so a
      // vault that keeps the default follows it if Holi ever changes it.
      const current = s.settings.plugins as PluginSettings
      const vault = { ...current.vault }
      if (a.on === a.byDefault) delete vault[a.id]
      else vault[a.id] = a.on
      return { ...s, settings: { ...s.settings, plugins: { ...current, vault } } }
    }
    case 'submitStart':
      return { ...s, submitting: true, error: null }
    case 'created':
      // The repo now exists and is pushed: advance to the PLUGINS act. Its
      // answer and the settings act's are merged over the seed's defaults
      // together, when the settings act continues. Only reached from naming
      // (naming), after create.
      return { ...s, act: 'plugins', submitting: false, error: null }
    case 'failInPlace':
      // A submit failure (create, or a join adopt) stays exactly where it
      // happened, with the message shown, rather than navigating away, which
      // reads as an unexplained reset.
      return { ...s, submitting: false, error: a.error }
    default:
      return s
  }
}
