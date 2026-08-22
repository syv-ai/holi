/**
 * The seed for "Summarize" on a mail thread (`prd/google-mail-calendar.md`).
 *
 * It is a first-person instruction to the agent, like the reconcile seed — the
 * drawer starts a real session with it, so the thread can be asked a follow-up
 * question rather than handing back one paragraph and closing.
 */
import { describe, expect, it } from 'vitest'
import { buildSummarizePrompt } from '../src/renderer/src/lib/summarize-prompt'

const thread = {
  subject: 'Q2 budget',
  threadId: '18c9a2f',
  webUrl: 'https://mail.google.com/mail/u/0/#inbox/18c9a2f',
}

describe('buildSummarizePrompt', () => {
  it('hands over the id the mail tool actually takes', () => {
    // `holi-google read <threadId>` is how the agent gets the messages. The
    // permalink is for the human; the id is the only part the tool can use, and
    // leaving it out makes the agent search for a thread it was already handed.
    const prompt = buildSummarizePrompt(thread)
    expect(prompt).toContain('holi-google read 18c9a2f')
  })

  it('names the thread so the drawer reads as being about something', () => {
    expect(buildSummarizePrompt(thread)).toContain('Q2 budget')
  })
})
