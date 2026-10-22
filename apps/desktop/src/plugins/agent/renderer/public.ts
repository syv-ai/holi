/**
 * What the agent offers a plugin that draws it (`agent-ui`, and any other
 * that declares `requires: ['agent']`): the one module of the agent's
 * renderer another plugin may import (eslint.config.mjs). Everything else
 * here is the agent's own.
 *
 * - **What the sessions are**: the lists main pushes, the questions it holds,
 *   and the transcript read into chat items.
 * - **What can be done to them**: the verbs, each answering done or why not.
 * - **The page slot** (`agentPageAtom`): a plugin that shows a session's chat
 *   fills it, and the agent's own surfaces (the inbox, a schedule's run, the
 *   quick panel's "open in Holi") open sessions through it. Empty, they say
 *   there is nowhere to show one.
 * - **Pieces the quick panel draws too**: the terminal on a session and the
 *   card for a question Holi holds.
 *
 * What a page shows (its selection, drafts, notices, turn review) is the
 * page's, not the agent's.
 */
export { agentCap } from './agent-cap'
export {
  agentArchivedAtom,
  agentHistoryAtom,
  agentPageAtom,
  agentSessionsAtom,
  agentTerminalsAtom,
  askTargetsAtom,
  NEW_SESSION,
  type AgentPage,
  type AgentResult,
  type AgentSession,
  type AgentTarget,
  type AgentTerminal,
  type PastSession,
  type SessionState,
} from './state/sessions'
export {
  answerHeldAtom,
  archiveSessionAtom,
  duplicateAtom,
  ensureTerminalAtom,
  failure,
  NO_AGENTS_PAGE,
  openSessionAtom,
  pressAtom,
  removeSessionAtom,
  respawnSessionAtom,
  sayAtom,
  startAtom,
  stopSessionAtom,
  uploadAtom,
  type Started,
} from './state/send'
export { agentQuestionsAtom, questionForAtom } from './state/questions'
export type { AskAnswers, PendingQuestion } from '../shared/questions'
export { openCalls } from '../shared/open-calls'

export type {
  ChatContext,
  ChatEntry,
  ChatItem,
  TaskState,
  ToolItem,
  ToolResult,
  ToolState,
} from './chat/items'
export { toChatItems, useQuestions, useTranscript } from './chat/use-transcript'
export {
  EMPTY_ANSWER,
  askFailed,
  isAnswered,
  keysForAll,
  openCallOf,
  type AskAnswer,
  type AskQuestion,
  type OpenCall,
} from './lib/ask'
export * from './chat/attachments'
export { agentIndicator, contextColour, needsYouIcon, sessionsWorthAsking } from './lib/notices'

export { SessionTerminal } from './SessionTerminal'
export { QuestionCard } from './quick/QuestionCard'
