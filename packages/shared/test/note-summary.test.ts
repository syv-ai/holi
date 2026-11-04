import { expect, test } from 'vitest'
import { summarizeNote } from '../src/note-summary'

test('the frontmatter description and tags speak for the note', () => {
  const s = summarizeNote(
    '---\ndescription: What ships this quarter.\ntags: [planning, q4]\n---\n# Roadmap\n\nFirst paragraph.\n',
  )
  expect(s.description).toBe('What ships this quarter.')
  expect(s.tags).toEqual(['planning', 'q4'])
})

test('without a description, the first prose paragraph does, as plain text', () => {
  const s = summarizeNote(
    '# Title\n\n- a list\n\nSee [[Roadmap|the plan]] and **ship** it.\n\nMore.',
  )
  expect(s.description).toBe('See the plan and ship it.')
  expect(s.tags).toEqual([])
})

test('words count the body only, and the preview is its first lines', () => {
  const s = summarizeNote('---\ndescription: x\n---\none two three\n\nfour')
  expect(s.words).toBe(4)
  expect(s.preview).toBe('one two three\n\nfour')
})

test('a long description is cut at a word, with an ellipsis', () => {
  const s = summarizeNote(`${'word '.repeat(80)}`)
  expect(s.description.length).toBeLessThanOrEqual(201)
  expect(s.description.endsWith('…')).toBe(true)
  expect(s.description).not.toMatch(/wor…$/)
})

test('a comma-separated tags string, broken YAML and an unclosed fence are all survivable', () => {
  expect(summarizeNote('---\ntags: a, b\n---\nx').tags).toEqual(['a', 'b'])
  expect(summarizeNote('---\n: : :\n---\nBody here.').description).toBe('Body here.')
  expect(summarizeNote('---\ndescription: never closed\nBody').words).toBeGreaterThan(0)
})
