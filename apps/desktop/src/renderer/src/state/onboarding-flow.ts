/**
 * Pure flow reducer for the first-run / add-vault onboarding ritual.
 *
 * The 4-act ritual (greeting → naming → settings → threshold) is driven entirely
 * by this reducer; `OnboardingRitual.tsx` is a thin view over it. Keeping the
 * flow pure lets it be unit-tested without a DOM (Vitest runs in `node` env).
 *
 * **Act 3 is the settings step and the threshold moved to 4.** Anything that
 * used to mean "the last act" by saying `3` now means the settings step — the
 * two are no longer the same number, and the assertion reads identically either
 * way.
 */
import { VAULT_SETTING_DESCRIPTORS, normaliseAnswers } from '@holi/shared'

export type Act = 1 | 2 | 3 | 4
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
   *  exactly what the seed already wrote rather than a second opinion about
   *  what a vault should default to. */
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
  // The settings act always advances: every row carries a default, so there is
  // nothing to fill in and nothing to block on. Act 4 is the floor of "there is
  // nowhere further".
  if (s.act === 3) return true
  return false
}

/** True on the form at the starting act — the point where `back` dismisses. */
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
      // daily notes off takes "today's note" off the landing row, and the value
      // sitting there becomes one the user can neither see nor change.
      return { ...s, settings: normaliseAnswers({ ...s.settings, [a.key]: a.value }) }
    case 'submitStart':
      return { ...s, submitting: true, error: null }
    case 'created':
      // The repo now exists and is pushed — advance to the SETTINGS act, which
      // is where its settings files get the user's answers merged over the
      // seed's defaults. The threshold is one further on (act 4) and is what
      // can truthfully say the repo exists. Only reached from act 2 (naming),
      // after create.
      return { ...s, act: 3, submitting: false, error: null }
    case 'failInPlace':
      // A submit failure (create, or a join adopt) stays exactly where it
      // happened — the naming form or the picker — with the message shown,
      // rather than navigating away, which reads as an unexplained reset.
      return { ...s, submitting: false, error: a.error }
    default:
      return s
  }
}
