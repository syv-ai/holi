/**
 * The seed message for **Summarize** on a mail thread — turn one of an agent
 * session started from the thread header, the same seam
 * `buildReconcilePrompt` uses.
 *
 * A seeded session rather than a headless call, deliberately: a summary is
 * usually followed by another question, and a one-shot summary would be a
 * second way to invoke the agent that you cannot reply to.
 */
export function buildSummarizePrompt(thread: {
  subject: string
  threadId: string
  webUrl: string
}): string {
  return [
    `Summarise this email thread for me: **${thread.subject}**.`,
    '',
    `Read it with \`holi google read ${thread.threadId}\`.`,
    '',
    'Tell me what it is about, what was decided, and what — if anything — is waiting on me. ' +
      'Keep it short; I can ask for more.',
    '',
    `The thread in Gmail, for reference: ${thread.webUrl}`,
  ].join('\n')
}
