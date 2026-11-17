import { afterEach, expect, it, vi } from 'vitest'

const { codeToHast, createHighlighterCore } = vi.hoisted(() => {
  const codeToHast = vi.fn()
  const createHighlighterCore = vi.fn(async () => ({
    codeToHast,
    getLoadedLanguages: () => [],
    loadLanguage: async () => {},
    loadTheme: async () => {},
  }))
  return { codeToHast, createHighlighterCore }
})

vi.mock('shiki/core', () => ({ createHighlighterCore }))
vi.mock('shiki/engine/javascript', () => ({
  createJavaScriptRegexEngine: () => ({}),
}))

import { highlightCode, resetCodeBlockHighlighter } from '../code-block-highlight'

afterEach(() => {
  resetCodeBlockHighlighter()
  codeToHast.mockReset()
})

it('returns plain lines and diff state for an unknown grammar', async () => {
  const lines = await highlightCode('before\nold\nnew', {
    language: 'not-a-real-grammar',
    diff: { removed: [2], added: [3] },
  })

  expect(lines.map((line) => line.state?.diff)).toEqual([undefined, 'remove', 'add'])
  expect(codeToHast).not.toHaveBeenCalled()
})

it('falls back to plain lines when highlighting throws', async () => {
  codeToHast.mockImplementation(() => {
    throw new Error('grammar failure')
  })

  const lines = await highlightCode('before\nold\nnew', {
    language: 'typescript',
    diff: { removed: [2], added: [3] },
  })

  expect(lines.map((line) => line.text)).toEqual(['before', 'old', 'new'])
  expect(lines.map((line) => line.state?.diff)).toEqual([undefined, 'remove', 'add'])
})

it('falls back to plain lines when Shiki returns no rendered lines', async () => {
  codeToHast.mockReturnValue({
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'pre',
        children: [{ type: 'element', tagName: 'code', children: [] }],
      },
    ],
  })

  const lines = await highlightCode('plain fallback', { language: 'typescript' })

  expect(lines.map((line) => line.text)).toEqual(['plain fallback'])
})

it('uses the returned tokens on successful highlighting', async () => {
  codeToHast.mockReturnValue({
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'pre',
        children: [
          {
            type: 'element',
            tagName: 'code',
            children: [
              {
                type: 'element',
                tagName: 'span',
                properties: { style: 'color: red' },
                children: [{ type: 'text', value: 'const' }],
              },
            ],
          },
        ],
      },
    ],
  })

  const lines = await highlightCode('const', { language: 'typescript' })

  expect(lines[0]?.tokens).toEqual([{ content: 'const', color: 'red' }])
})
