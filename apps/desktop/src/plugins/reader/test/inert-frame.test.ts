import { describe, expect, it, vi } from 'vitest'

vi.mock('@/plugin-api', () => ({ openExternal: vi.fn() }))

const { inertFrameDocument } = await import('../renderer/inert-frame')

/** The policy, as the frame document spells it. */
const INERT_CSP = /content="([^"]*)"/.exec(inertFrameDocument({ background: 'white' }))?.[1] ?? ''

describe('the inert frame', () => {
  it('lets file content load only what it carries inside itself', () => {
    expect(INERT_CSP).toContain("default-src 'none'")
    expect(INERT_CSP).not.toMatch(/https?:|'unsafe-eval'|script-src/)
  })

  it('puts the policy first in the head, before any style', () => {
    const doc = inertFrameDocument({ css: 'p { color: red }', background: 'white' })
    const head = doc.slice(doc.indexOf('<head>'))
    expect(head.indexOf('Content-Security-Policy')).toBeLessThan(head.indexOf('<style'))
  })
})
