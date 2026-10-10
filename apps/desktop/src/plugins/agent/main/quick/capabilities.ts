/**
 * The quick agent's capabilities (docs/features/quick-agent.md), under the
 * agent's namespace and through the UI door only.
 *
 * - **Questions**: the calls the quick agents are waiting on, and answering
 *   one, which the card over a session's tab in the main window does. The
 *   quick panel answers its own through its page.
 * - **Settings**: this machine's, not the vault's (`settings.ts`): whether the
 *   keys are on, the hotkey and the dock's key, and macOS's Accessibility
 *   permission.
 * - **The dock**: its key, which the main window answers itself.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  cap,
  CapabilityError,
  noParams,
  optionalStringParam,
  paramsObject,
  stringParam,
  type CapabilityContext,
} from '../../../../main/plugin-api'
import { parseAnswers, type AskAnswers, type PendingQuestion } from '../../shared/questions'
import type { QuestionDesk } from '../host/questions'
import type { QuickSettingsPatch, QuickSettingsState } from '../../shared/quick'
import type { QuickAgent } from './index'

export interface QuickCapabilitiesDeps {
  desk: Pick<QuestionDesk, 'pending' | 'answer'>
  /** Null until the quick agent has started. */
  quick(): QuickAgent | null
  /** The open vault's remote, or null with none open. */
  liveRemote(): string | null
}

function answersParam(raw: Record<string, unknown>): AskAnswers {
  const answers = parseAnswers(raw['answers'])
  if (answers === null) {
    throw new CapabilityError('BAD_REQUEST', 'answers must be an object of strings')
  }
  return answers
}

export const quickCapabilities = (deps: QuickCapabilitiesDeps) => {
  const live = (ctx: CapabilityContext): boolean => deps.liveRemote() === ctx.remote
  const quick = (): QuickAgent => {
    const q = deps.quick()
    if (q === null) throw new CapabilityError('UNAVAILABLE', 'The quick agent is not running.')
    return q
  }

  return {
    /** The questions the open vault's quick agents are waiting on, oldest first. */
    'agent.questions': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx): Promise<PendingQuestion[]> => (live(ctx) ? [...deps.desk.pending()] : []),
    }),

    /** Answer one: false when it is gone, or the answers leave one unanswered. */
    'agent.answer': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return { id: stringParam(p, 'id'), answers: answersParam(p) }
      },
      run: async (ctx, { id, answers }): Promise<boolean> =>
        live(ctx) && deps.desk.answer(id, answers),
    }),

    'agent.quickSettings': cap({
      doors: ['ui'],
      params: noParams,
      run: (): Promise<QuickSettingsState> => quick().settings(),
    }),

    'agent.setQuickSettings': cap({
      doors: ['ui'],
      params: (raw): QuickSettingsPatch => {
        const p = paramsObject(raw)
        const enabled = p['enabled']
        if (enabled !== undefined && typeof enabled !== 'boolean') {
          throw new CapabilityError('BAD_REQUEST', 'enabled must be true or false')
        }
        const hotkey = optionalStringParam(p, 'hotkey')
        const dockHotkey = optionalStringParam(p, 'dockHotkey')
        return {
          ...(enabled === undefined ? {} : { enabled }),
          ...(hotkey === undefined ? {} : { hotkey }),
          ...(dockHotkey === undefined ? {} : { dockHotkey }),
        }
      },
      run: async (_ctx, patch): Promise<QuickSettingsState> => {
        try {
          return await quick().setSettings(patch)
        } catch (err) {
          if (err instanceof CapabilityError) throw err
          throw new CapabilityError('BAD_REQUEST', (err as Error).message)
        }
      },
    }),

    /** The dock's key, pressed in the main window: Holi holds it globally only
     *  while none of its windows has the keyboard, so the window answers it
     *  through this. False while the keys are off. */
    'agent.quickDock': cap({
      doors: ['ui'],
      params: noParams,
      run: (): Promise<boolean> => quick().dock(),
    }),

    /** macOS's own Accessibility prompt. True once Holi has the permission. */
    'agent.requestAccessibility': cap({
      doors: ['ui'],
      params: noParams,
      run: async (): Promise<boolean> => quick().requestAccessibility(),
    }),
  }
}
