import { describe, expect, it } from 'vitest'
import { cleanMailText, cleanSearchSnippet } from '../main/mail-text'

describe('cleanMailText', () => {
  it('removes a marked inline quote but keeps the authored answer after it', () => {
    expect(
      cleanMailText(
        'Thanks for the update.\n\nOn Tue, Jan 2, 2024, Bob wrote:\n> Can we move the launch?\nYes, Thursday works.',
      ),
    ).toBe('Thanks for the update.\n\nYes, Thursday works.')
  })

  it('preserves later authored blockquotes once prose resumes after reply history', () => {
    expect(
      cleanMailText(
        'On Tuesday Ada wrote:\n> Can you share the release note?\n\nYes, here is the exact wording to publish:\n> The release is postponed until Friday.\nPlease use that wording.',
      ),
    ).toBe(
      'Yes, here is the exact wording to publish:\n> The release is postponed until Friday.\nPlease use that wording.',
    )
  })

  it('removes bottom-posted quotes when the quote itself is marked', () => {
    expect(
      cleanMailText(
        'Agreed.\n\nOn Tue, Jan 2, 2024, Bob wrote:\n> Please review the attached draft.\n> We need feedback by Friday.',
      ),
    ).toBe('Agreed.')
  })

  it('recognizes localized reply and well-formed forward markers', () => {
    expect(cleanMailText('Bonjour\n\nLe 2 janvier, Alice a écrit :\n> ancien texte')).toBe(
      'Bonjour',
    )
    expect(
      cleanMailText(
        'New note\n\n---------- Forwarded message ----------\nFrom: Alice <a@example.com>\nDate: Tue\nTo: Bob\nSubject: Plan\nold mail',
      ),
    ).toBe('New note')
    expect(
      cleanMailText('Message\n----- Forwarded message -----\nFrom: someone\nSubject: incomplete'),
    ).toContain('Forwarded message')
  })

  it('removes mobile signatures and provider-backed meeting lines without losing prose', () => {
    expect(cleanMailText('See you then.\nSent from my iPhone')).toBe('See you then.')
    expect(
      cleanMailText(
        'Agenda\nJoin with Google Meet\nhttps://meet.google.com/abc-defg-hij\n\nPlease bring the revised plan.',
      ),
    ).toBe('Agenda\nPlease bring the revised plan.')
    expect(cleanMailText('Join meeting tomorrow and bring the draft.\nMore below.')).toBe(
      'Join meeting tomorrow and bring the draft.\nMore below.',
    )
  })

  it('preserves prose after signatures and meeting blocks, even if it resembles another label', () => {
    expect(cleanMailText('Ready.\n-- \nAda\nada@example.com\n\nP.S. Bring the draft.')).toBe(
      'Ready.\n\nP.S. Bring the draft.',
    )
    expect(cleanMailText('Ready.\n-- \nAda\nP.S. Bring the draft.')).toBe(
      'Ready.\nP.S. Bring the draft.',
    )
    expect(cleanMailText('Ready.\nSent from my iPhone\nPlease bring the draft.')).toBe(
      'Ready.\nPlease bring the draft.',
    )
    expect(
      cleanMailText(
        'Join meeting\nhttps://meet.google.com/abc-defg-hij\nJoin meeting tomorrow with the draft.',
      ),
    ).toBe('Join meeting tomorrow with the draft.')
    expect(
      cleanMailText('Join meeting\nMy notes are at https://meet.google.com/abc-defg-hij'),
    ).toBe('Join meeting\nMy notes are at https://meet.google.com/abc-defg-hij')
  })

  it('keeps ambiguous unmarked history and recognizes Danish and German marked quotes', () => {
    expect(cleanMailText('On Tuesday Alice wrote:\nThese words might be the new answer.')).toBe(
      'On Tuesday Alice wrote:\nThese words might be the new answer.',
    )
    expect(
      cleanMailText('Den 10. november skrev Ada:\n> Er tallene korrekte?\nJa, de stemmer.'),
    ).toBe('Ja, de stemmer.')
    expect(cleanMailText('Am Dienstag schrieb Ada:\n> Bitte prüfen.\nDie Zahlen stimmen.')).toBe(
      'Die Zahlen stimmen.',
    )
    expect(cleanMailText('-----Original Message-----\nOnly an example, not a mail header.')).toBe(
      '-----Original Message-----\nOnly an example, not a mail header.',
    )
  })

  it('preserves sign-offs, separators, standalone quote markers and malformed content', () => {
    expect(cleanMailText('Thanks,\nAda.\n\nP.S. -- I will follow up!')).toBe(
      'Thanks,\nAda.\n\nP.S. -- I will follow up!',
    )
    expect(cleanMailText('I wrote this: On a wall, nobody wrote:')).toBe(
      'I wrote this: On a wall, nobody wrote:',
    )
    expect(cleanMailText('-- I disagree with this.')).toBe('-- I disagree with this.')
    expect(cleanMailText('A markdown separator follows.\n--\nP.S. I will send the link.')).toBe(
      'A markdown separator follows.\n--\nP.S. I will send the link.',
    )
    expect(cleanMailText('> This may be a quote, but has no attribution.')).toBe(
      '> This may be a quote, but has no attribution.',
    )
    expect(cleanMailText('Body\nOn Tue wrote\nnot a valid quote marker')).toBe(
      'Body\nOn Tue wrote\nnot a valid quote marker',
    )
  })
})

describe('cleanSearchSnippet', () => {
  it('decodes named and numeric entities before removing invisible controls', () => {
    expect(cleanSearchSnippet('\u200bHello&#8203;&nbsp;&amp; &#x1F642; &zwnj; &shy;')).toBe(
      'Hello & 🙂',
    )
  })

  it('leaves malformed entities intact', () => {
    expect(cleanSearchSnippet('A &not-an-entity; B &#xZZ;')).toBe('A &not-an-entity; B &#xZZ;')
  })
})
