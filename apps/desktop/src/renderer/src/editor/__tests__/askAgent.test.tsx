/**
 * The message an ask to the agent sends: the instruction first, the quoted
 * passage under it.
 */
import { describe, expect, it } from 'vitest'
import { askPrompt } from '../askAgent'

describe('askPrompt', () => {
  const QUOTE = '[From a.md, line 1]\n> one'

  it('puts the instruction first and the passage under it', () => {
    // The instruction is the sentence to act on; a quote reads as context for
    // what precedes it.
    expect(askPrompt('Tighten this', QUOTE)).toBe(`Tighten this\n\n${QUOTE}`)
  })

  it('sends the passage alone when nothing was typed', () => {
    // What the button did before it grew a field, and "look at this" is a real
    // thing to want to say.
    expect(askPrompt('', QUOTE)).toBe(QUOTE)
    expect(askPrompt('   \n  ', QUOTE)).toBe(QUOTE)
  })

  it('does not carry the field’s stray whitespace into the message', () => {
    expect(askPrompt('  Tighten this\n', QUOTE)).toBe(`Tighten this\n\n${QUOTE}`)
  })
})
