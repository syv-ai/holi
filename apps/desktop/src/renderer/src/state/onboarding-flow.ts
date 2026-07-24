/**
 * Pure flow reducer for the first-run / add-vault onboarding ritual.
 *
 * The 3-act ritual (greeting → naming → threshold) is driven entirely by this
 * reducer; `OnboardingRitual.tsx` is a thin view over it. Keeping the flow pure
 * lets it be unit-tested without a DOM (Vitest runs in `node` env here).
 */

export type Act = 1 | 2 | 3
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
  submitting: false
})

export const canAdvance = (s: OnboardingState): boolean => {
  if (s.act === 1) return true
  if (s.act === 2) return slugify(s.name).length > 0
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
  | { type: 'submitStart' }
  | { type: 'fail'; error: string }

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
    case 'submitStart':
      return { ...s, submitting: true, error: null }
    case 'fail':
      return { ...s, submitting: false, error: a.error, act: 2, view: 'form' }
    default:
      return s
  }
}
