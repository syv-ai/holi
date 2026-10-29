/**
 * Pure flow reducer for the first-run / add-vault onboarding ritual.
 *
 * The acts, in order, are `ACTS`; everything that walks them (advance, back,
 * the floor, the step dots) reads that list, so adding an act is adding it
 * there.
 *
 * **Nothing is created until the last question is answered.** Naming, plugins
 * and settings only collect answers; "Create vault" on the settings act moves
 * to the threshold, which shows the vault being built (repo, then answers)
 * and turns into "ready" when it is. So backing out of any act before that
 * leaves nothing behind on GitHub, and the answers land in the first commit
 * after the seed rather than over a vault someone could already have cloned. `onboarding-ritual.tsx` is a thin view over this reducer, and keeping
 * the flow pure lets it be unit-tested without a DOM.
 */
import { VAULT_SETTING_DESCRIPTORS, normaliseAnswers, type PluginSettings } from '@holi/shared'

const ACTS = ['greeting', 'naming', 'plugins', 'settings', 'threshold'] as const
export type Act = (typeof ACTS)[number]
type View = 'form' | 'join'
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
const actIndex = (act: Act): number => ACTS.indexOf(act)

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

/** The name a vault gets when the field is left empty: shown as the field's
 *  placeholder and in the repo path, so the naming act never starts on a
 *  blank or an ellipsis, and Create works without typing anything. */
export const DEFAULT_VAULT_NAME = 'holi-vault'

/** The repo name the naming act would create: the typed name slugified, or
 *  the default while nothing is typed. A typed name that slugifies to nothing
 *  (only punctuation) stays empty rather than quietly becoming the default. */
export const vaultSlug = (name: string): string =>
  name.trim() === '' ? DEFAULT_VAULT_NAME : slugify(name)

export const canAdvance = (s: OnboardingState): boolean => {
  if (s.act === 'naming') return vaultSlug(s.name).length > 0
  // The plugins and settings acts always advance: every row carries a default,
  // so there is nothing to fill in and nothing to block on. The threshold is
  // the last.
  return s.act !== 'threshold'
}

/**
 * True on the form at the starting act: the point where `back` dismisses.
 * @public exported for its test
 */
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
  | { type: 'createFailed'; error: string }
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
      // The repo exists, is pushed and holds the answers: the threshold, where
      // the build has been showing, now says ready.
      return { ...s, submitting: false, error: null }
    case 'createFailed':
      // The repo could not be made, which is nearly always about its name
      // (taken, or not allowed under that owner): back to naming with the
      // reason, the other answers kept.
      return { ...s, act: 'naming', view: 'form', submitting: false, error: a.error }
    case 'failInPlace':
      // A submit failure (create, or a join adopt) stays exactly where it
      // happened, with the message shown, rather than navigating away, which
      // reads as an unexplained reset.
      return { ...s, submitting: false, error: a.error }
    default:
      return s
  }
}
