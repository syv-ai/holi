import { describe, expect, it } from 'vitest'
import { cleanMailText, cleanSearchSnippet } from '../main/mail-text'

describe('cleanMailText', () => {
  it('strips recognized English reply history and delimiter signatures', () => {
    expect(
      cleanMailText(
        'Thanks for the update.\n\n-- \nAda\n\nOn Tue, Jan 2, 2024, Bob wrote:\nold text',
      ),
    ).toBe('Thanks for the update.')
  })

  it('recognizes localized reply and forward markers', () => {
    expect(cleanMailText('Bonjour\n\nLe 2 janvier, Alice a écrit :\nancien texte')).toBe('Bonjour')
    expect(cleanMailText('New note\n\n---------- Forwarded message ----------\nold mail')).toBe(
      'New note',
    )
  })

  it('removes recognized mobile signatures and calendar join boilerplate', () => {
    expect(cleanMailText('See you then.\nSent from my iPhone')).toBe('See you then.')
    expect(cleanMailText('Agenda\nJoin with Google Meet\nhttps://meet.google.com/abc')).toBe(
      'Agenda',
    )
  })

  it('preserves sign-offs, punctuation, and unrecognized or malformed content', () => {
    expect(cleanMailText('Thanks,\nAda.\n\nP.S. -- I will follow up!')).toBe(
      'Thanks,\nAda.\n\nP.S. -- I will follow up!',
    )
    expect(cleanMailText('I wrote this: On a wall, nobody wrote:')).toBe(
      'I wrote this: On a wall, nobody wrote:',
    )
    expect(cleanMailText('-- I disagree with this.')).toBe('-- I disagree with this.')
    expect(cleanMailText('Body\nOn Tue wrote\nnot a valid quote marker')).toBe(
      'Body\nOn Tue wrote\nnot a valid quote marker',
    )
  })
})

describe('cleanSearchSnippet', () => {
  it('removes invisible preheader characters and decodes HTML entities', () => {
    expect(cleanSearchSnippet('\u200bHello&nbsp;&amp; &#x1F642;')).toBe('Hello & 🙂')
  })

  it('leaves malformed entities intact', () => {
    expect(cleanSearchSnippet('A &not-an-entity; B &#xZZ;')).toBe('A &not-an-entity; B &#xZZ;')
  })
})
