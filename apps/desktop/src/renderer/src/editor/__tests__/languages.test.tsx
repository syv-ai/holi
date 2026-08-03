import { describe, expect, it } from 'vitest'
import { languageIdForPath, syntaxValid } from '../languages'

describe('languageIdForPath', () => {
  it('maps config extensions to a language', () => {
    expect(languageIdForPath('.holi/theme.json')).toBe('json')
    expect(languageIdForPath('notes/data.jsonc')).toBe('json')
    expect(languageIdForPath('config.yaml')).toBe('yaml')
    expect(languageIdForPath('config.yml')).toBe('yaml')
    expect(languageIdForPath('Cargo.toml')).toBe('toml')
    expect(languageIdForPath('settings.ini')).toBe('ini')
    expect(languageIdForPath('app.conf')).toBe('ini')
    expect(languageIdForPath('deploy.sh')).toBe('shell')
    expect(languageIdForPath('run.bash')).toBe('shell')
  })

  it('classifies dotfiles by name, not by a phantom extension', () => {
    // `.env` has no `name.ext` split — the leading dot is not a separator.
    expect(languageIdForPath('.env')).toBe('ini')
    expect(languageIdForPath('project/.env.local')).toBe('ini')
    expect(languageIdForPath('.bashrc')).toBe('shell')
    expect(languageIdForPath('.zshrc')).toBe('shell')
  })

  it('is case-insensitive on the extension', () => {
    expect(languageIdForPath('THEME.JSON')).toBe('json')
    expect(languageIdForPath('Config.YAML')).toBe('yaml')
  })

  it('returns null for text with no known language (edit as plain)', () => {
    expect(languageIdForPath('notes.txt')).toBeNull()
    expect(languageIdForPath('data.csv')).toBeNull()
    expect(languageIdForPath('Makefile')).toBeNull()
    expect(languageIdForPath('.gitignore')).toBeNull()
  })

  it('ignores a dot in a directory when the file itself has no extension', () => {
    expect(languageIdForPath('my.config/Makefile')).toBeNull()
  })
})

describe('syntaxValid', () => {
  it('gates JSON on parseability', () => {
    expect(syntaxValid('.holi/theme.json', '{"a": 1}')).toBe(true)
    expect(syntaxValid('.holi/theme.json', '{"a": 1,}')).toBe(false)
    expect(syntaxValid('.holi/theme.json', '{ not json')).toBe(false)
  })

  it('gates YAML on parseability', () => {
    expect(syntaxValid('config.yaml', 'a: 1\nb: two')).toBe(true)
    expect(syntaxValid('config.yaml', 'a: [1, 2')).toBe(false)
  })

  it('never gates a format it cannot cheaply parse', () => {
    // toml/ini/shell and unknown text have no gate — always savable.
    expect(syntaxValid('Cargo.toml', 'this is = not [valid toml')).toBe(true)
    expect(syntaxValid('.env', 'A=1\n= broken')).toBe(true)
    expect(syntaxValid('notes.txt', 'anything at all {[(')).toBe(true)
  })

  it('treats an empty or whitespace buffer as valid (nothing to be invalid)', () => {
    expect(syntaxValid('.holi/theme.json', '')).toBe(true)
    expect(syntaxValid('.holi/theme.json', '   \n  ')).toBe(true)
    expect(syntaxValid('config.yaml', '')).toBe(true)
  })
})
