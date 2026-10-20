import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { expect, test } from 'vitest'
import { currentHeading, outlineOf } from '../outline'

const state = (doc: string) => EditorState.create({ doc, extensions: [markdown()] })

test('lists ATX and setext headings with their level and plain text', () => {
  const doc = '# Title\n\nText\n\n## **Bold** part ##\n\nSetext\n---\n\n### [[Link]]\n'
  expect(outlineOf(state(doc)).map(({ level, text }) => [level, text])).toEqual([
    [1, 'Title'],
    [2, 'Bold part'],
    [2, 'Setext'],
    [3, 'Link'],
  ])
})

test('a # inside a code fence is not a heading', () => {
  expect(outlineOf(state('```sh\n# comment\n```\n\n## Real\n'))).toHaveLength(1)
})

test('the current heading is the last one at or before the position', () => {
  const hs = outlineOf(state('# A\n\none\n\n## B\n\ntwo\n'))
  expect(currentHeading(hs, 0)).toBe(0)
  expect(currentHeading(hs, hs[1]!.from + 3)).toBe(1)
  expect(currentHeading([], 10)).toBe(-1)
})
