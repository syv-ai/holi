/**
 * The finished message: the instruction first, since that is what the agent
 * acts on, then the quote as context. An empty instruction sends the quote alone.
 */
export function askPrompt(instruction: string, quote: string): string {
  const said = instruction.trim()
  return said === '' ? quote : `${said}\n\n${quote}`
}

export interface AskTarget {
  id: string
  name: string
}

/** What the popover offers, read when it opens: sessions come and go. */
export interface AskTargets {
  /** Live sessions in tab order. The caller leaves out one blocked on its own
   *  question, where the text would sit unread. */
  sessions: AskTarget[]
  /** Selected when the popover opens: the session you are on, or `'new'` when
   *  that session cannot take an ask. */
  initial: string | 'new'
}

/** Sent, or refused with a reason the popover shows while keeping the text. */
export interface AskResult {
  ok: boolean
  message?: string
}

/** The editor's whole view of the agent: a list of names, and somewhere to send. */
export interface AskAgentSeam {
  targets: () => AskTargets
  onAsk: (prompt: string, target: string | 'new') => Promise<AskResult>
}
