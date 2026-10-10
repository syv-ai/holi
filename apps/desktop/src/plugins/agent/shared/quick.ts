/**
 * The quick agent's vocabulary, shared by its main side and its panel
 * (docs/features/quick-agent.md). Pure: no Node, no DOM.
 */
import { isRecord, parseAnswers, type AskAnswers, type PendingQuestion } from './questions'

/**
 * Where a quick agent is, which is what its panel shows.
 *
 * - `working`: yellow. Starting, or mid-turn.
 * - `question`: Holi holds an AskUserQuestion call; the panel shows the card.
 * - `prompt`: Claude Code is waiting in its own UI (a permission prompt, or a
 *   question that fell through to its own box); the panel shows that session's
 *   terminal, so the prompt is Claude Code's own.
 * - `done`: green. The turn ended and the session waits for its next message.
 * - `failed`: red. Claude Code says it failed, or its process died unfinished.
 * - `gone`: stopped, or no longer listed. The panel closes.
 */
export type QuickState = 'working' | 'question' | 'prompt' | 'done' | 'failed' | 'gone'

/** The states that want the person: a press of the dock's key goes to the
 *  oldest of these first. */
export const ASKING_STATES: readonly QuickState[] = ['question', 'prompt']
/** The states a turn ends in: the agent stays in the dock until the person
 *  clears it. */
export const FINISHED_STATES: readonly QuickState[] = ['done', 'failed']

/** What a panel shows, as main tells it (`quick-view`). */
export type QuickView =
  /** Typing the task. `selection` is what was selected in the app the person
   *  came from, attached until they remove it. */
  | { kind: 'prompt'; remote: string | null; selection: QuickSelection | null }
  /** The first press without the Accessibility permission: one line on why,
   *  and a key to open System Settings. */
  | { kind: 'access'; remote: string | null; selection: null }
  /** A running quick agent. `question` is set while its state is `question`;
   *  `terminalId` while its state is `prompt` and its terminal is open. */
  | {
      kind: 'agent'
      remote: string
      job: string
      name: string
      state: QuickState
      question: PendingQuestion | null
      terminalId: string | null
      /** Why it failed, when Holi knows (a start that never began). */
      error?: string
      /** Done: its last message, the answer, in markdown. */
      result?: string
    }

/** The quick agent's settings, as the settings section shows them. */
export interface QuickSettingsState {
  enabled: boolean
  /** In Holi's glyphs, such as `⌘J`: a new prompt at the pointer. */
  hotkey: string
  /** Another app held the key the last time Holi asked for it. */
  conflict: boolean
  /** The dock's key, such as `⌃⌘J`: the dock, with the keyboard. */
  dockHotkey: string
  /** Another app held the dock's key the last time Holi asked for it. */
  dockConflict: boolean
  /** Holi may read other apps' selections (macOS's Accessibility permission). */
  accessibility: boolean
}

/** A change to the settings: the switch, or either key. */
export type QuickSettingsPatch = Partial<
  Pick<QuickSettingsState, 'enabled' | 'hotkey' | 'dockHotkey'>
>

/** Text selected in another app when the hotkey was pressed. */
export interface QuickSelection {
  /** The app it came from, as macOS names it. */
  app: string
  text: string
}

/** What a panel asks of main, as its page's `quick` message. Main hears each
 *  only from the window that sent it, so none names its panel. */
export type QuickRequest =
  /** The page is listening: send the view. */
  | { kind: 'ready' }
  | { kind: 'submit'; prompt: string; selection: boolean }
  | { kind: 'answer'; questionId: string; answers: AskAnswers }
  /** Out of sight, the agent still running and its dot still there: esc in
   *  an agent's panel, or a prompt with a draft left when the person clicked
   *  away. */
  | { kind: 'hide' }
  /** Gone: a prompt never sent, or a finished agent's panel, whose session
   *  stops with it. */
  | { kind: 'clear' }
  | { kind: 'open-session' }
  /** The hotkey pressed inside a panel: another agent. */
  | { kind: 'new' }
  /** ↑ ↓ in an agent's panel: the agent above or below it in the dock. */
  | { kind: 'step'; dir: 1 | -1 }
  /** The dock's key pressed inside a prompt: the dock, with the keyboard. */
  | { kind: 'dock' }
  /** The pointer came onto a panel or left it: a panel shown by hovering a
   *  dot stays while the pointer is on it. */
  | { kind: 'pointer'; inside: boolean }
  | { kind: 'grant-access' }
  | { kind: 'skip-access' }
  /** What the page needs to show itself, in CSS pixels, and how far down it
   *  the middle of its header is: that is what lines up with its dot. */
  | { kind: 'size'; width: number; height: number; header?: number }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A page's message as main reads it: one of the requests above, or null. */
export function parseQuickRequest(raw: unknown): QuickRequest | null {
  if (!isRecord(raw)) return null
  switch (raw['kind']) {
    case 'ready':
    case 'hide':
    case 'clear':
    case 'open-session':
    case 'new':
    case 'dock':
    case 'grant-access':
    case 'skip-access':
      return { kind: raw['kind'] }
    case 'step':
      return raw['dir'] === 1 || raw['dir'] === -1 ? { kind: 'step', dir: raw['dir'] } : null
    case 'pointer':
      return typeof raw['inside'] === 'boolean' ? { kind: 'pointer', inside: raw['inside'] } : null
    case 'submit':
      return typeof raw['prompt'] === 'string'
        ? { kind: 'submit', prompt: raw['prompt'], selection: raw['selection'] === true }
        : null
    case 'answer': {
      const answers = parseAnswers(raw['answers'])
      return typeof raw['questionId'] === 'string' && answers !== null
        ? { kind: 'answer', questionId: raw['questionId'], answers }
        : null
    }
    case 'size': {
      const { width, height, header } = raw
      if (!finite(width) || !finite(height)) return null
      return { kind: 'size', width, height, ...(finite(header) ? { header } : {}) }
    }
    default:
      return null
  }
}

/**
 * One quick agent in the dock: a dot in its light's colour. `id` is its panel,
 * which a start that failed has without a job.
 */
export interface DockDot {
  id: string
  name: string
  state: QuickState
}

/** What the dock shows, as main tells it (`dock-view`): every quick agent,
 *  oldest first, and the one whose panel is out beside it. `remote` is the
 *  open vault, whose theme can recolour the lights. */
export interface DockView {
  remote: string | null
  dots: DockDot[]
  selected: string | null
}

/** What the dock's page asks of main, as its `dock` message. */
export type DockRequest =
  /** The page is listening: send the view. */
  | { kind: 'ready' }
  /** The pointer is on a dot, or has left the dock (null). */
  | { kind: 'hover'; id: string | null }
  /** A dot clicked: its panel comes out with the keyboard. */
  | { kind: 'pick'; id: string }
  /** What the page needs, in CSS pixels, and each dot's centre measured down
   *  from the dock's top, so a panel comes out level with its dot. */
  | { kind: 'size'; width: number; height: number; dots: number[] }

/** The dock's message as main reads it: one of the requests above, or null. */
export function parseDockRequest(raw: unknown): DockRequest | null {
  if (!isRecord(raw)) return null
  switch (raw['kind']) {
    case 'ready':
      return { kind: 'ready' }
    case 'hover':
      return raw['id'] === null || typeof raw['id'] === 'string'
        ? { kind: 'hover', id: raw['id'] }
        : null
    case 'pick':
      return typeof raw['id'] === 'string' ? { kind: 'pick', id: raw['id'] } : null
    case 'size': {
      const { width, height, dots } = raw
      return finite(width) && finite(height) && Array.isArray(dots) && dots.every(finite)
        ? { kind: 'size', width, height, dots }
        : null
    }
    default:
      return null
  }
}

/**
 * The first turn of a quick agent: the task, then the selection it was asked
 * about, quoted, with the app it came from. A selection is context for the
 * task, so it goes after it.
 */
export function quickPrompt(task: string, selection: QuickSelection | null): string {
  const trimmed = task.trim()
  if (selection === null || selection.text.trim() === '') return trimmed
  const fence = selection.text.includes('```') ? '~~~~' : '```'
  return `${trimmed}\n\nSelected in ${selection.app}:\n\n${fence}\n${selection.text}\n${fence}`
}
