import { describe, expect, it } from 'vitest'
import { cleanLogins, hasLogin, sameLogin, toggleLogin } from '../src/logins'

describe('one rule for a login', () => {
  it('is the same person whatever the case', () => {
    expect(sameLogin('Ada', 'ada')).toBe(true)
    expect(sameLogin('ada', 'adam')).toBe(false)
    expect(hasLogin(['Ada'], 'ADA')).toBe(true)
  })

  it('makes a clean list: no @, no blanks, each person once in the spelling given first', () => {
    expect(cleanLogins(['Ada', ' @ada ', '', '@', 'bo', 'BO'])).toEqual(['Ada', 'bo'])
  })

  it('toggles a person by any spelling of their name', () => {
    expect(toggleLogin(['Ada', 'bo'], 'ada')).toEqual(['bo'])
    expect(toggleLogin(['bo'], 'Ada')).toEqual(['bo', 'Ada'])
  })
})
