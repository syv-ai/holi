/**
 * Pure flow reducer for the first-run / add-vault onboarding ritual.
 *
 * The 5-act ritual (greeting → naming → plugins → settings → threshold) is driven entirely
 * by this reducer; `OnboardingRitual.tsx` is a thin view over it. Keeping the
 * flow pure lets it be unit-tested without a DOM.
 */
import { VAULT_SETTING_DESCRIPTORS, normaliseAnswers, type PluginSettings } from '@holi/shared'

export type Act = 1 | 2 | 3 | 4 | 5
export type View = 'form' | 'join'
export type Mode = 'first-run' | 'add-vault'

export interface OnboardingState {
  act: Act
  /** 'join' overlays act 2 with the repo picker. */
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
export const startingAct = (mode: Mode): Act => (mode === 'first-run' ? 1 : 2)

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
  if (s.act === 1) return true
  if (s.act === 2) return slugify(s.name).length > 0
  // The plugins and settings acts always advance: every row carries a default,
  // so there is nothing to fill in and nothing to block on. Act 5 is the last.
  if (s.act === 3 || s.act === 4) return true
  return false
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
      const act = (s.act + 1) as Act
      return { ...s, act, error: null }
    }
    case 'back': {
      if (s.view === 'join') return { ...s, view: 'form', error: null }
      const floor = startingAct(a.mode)
      const act = Math.max(floor, s.act - 1) as Act
      return { ...s, act, error: null }
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
      // together, when the settings act continues. Only reached from act 2
      // (naming), after create.
      return { ...s, act: 3, submitting: false, error: null }
    case 'failInPlace':
      // A submit failure (create, or a join adopt) stays exactly where it
      // happened, with the message shown, rather than navigating away, which
      // reads as an unexplained reset.
      return { ...s, submitting: false, error: a.error }
    default:
      return s
  }
}
