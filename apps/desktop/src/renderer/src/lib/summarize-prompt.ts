/**
 * The seed message for **Summarize** on a mail thread — turn one of an agent
 * session started from the thread header, the same seam
 * `buildReconcilePrompt` uses.
 *
 * A seeded session rather than a headless call, deliberately: the answer to
 * "what is this thread about" is usually followed by another question, and the
 * drawer is where that conversation already lives. A one-shot summary rendered
 * in the header would be a second way to invoke the agent, with its own
 * spinner and error state, that you cannot reply to.
 */
export function buildSummarizePrompt(thread: {
  subject: string
  threadId: string
  webUrl: string
}): string {
  return [
    `Summarise this email thread for me: **${thread.subject}**.`,
    '',
    `Read it with \`holi-google read ${thread.threadId}\`.`,
    '',
    'Tell me what it is about, what was decided, and what — if anything — is waiting on me. ' +
      'Keep it short; I can ask for more.',
    '',
    `The thread in Gmail, for reference: ${thread.webUrl}`,
  ].join('\n')
}
