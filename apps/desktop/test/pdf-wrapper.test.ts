import { describe, expect, it } from 'vitest'
import { composeWrapper, typstDict, typstString } from '../src/main/pdf/wrapper'

describe('typstString', () => {
  it('wraps in quotes and escapes backslashes and quotes', () => {
    expect(typstString('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
})

describe('typstDict', () => {
  it('renders an empty map as the empty-dict literal (:)', () => {
    expect(typstDict({})).toBe('(:)')
  })
  it('renders string entries as a Typst dictionary', () => {
    expect(typstDict({ date: '2026-07-26', to: 'ACME' })).toBe('(date: "2026-07-26", to: "ACME")')
  })
})

describe('composeWrapper', () => {
  it('imports the template and calls doc with absolute paths + meta', () => {
    const out = composeWrapper({
      templateDir: '/v/.holi/templates/plain',
      notePath: '/v/notes/report.md',
      assetsDir: '/v/.holi/templates/plain/assets',
      meta: {},
    })
    expect(out).toBe(
      '#import "/v/.holi/templates/plain/template.typ": doc\n' +
        '#doc("/v/notes/report.md", meta: (:), assets: "/v/.holi/templates/plain/assets")\n',
    )
  })
})
