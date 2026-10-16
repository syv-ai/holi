/**
 * Grep and Glob: what was looked for, and the list of what was found. The
 * count comes from the structured result when there is one, else from the
 * lines of the text.
 */
import { Search } from 'lucide-react'
import type { ToolRenderer } from '../registry'
import {
  argsOf,
  countLabel,
  dataOf,
  firstStr,
  flag,
  num,
  shortPath,
  textOf,
  unwrap,
} from './coerce'
import { CodeBlock, ErrorPane, Stack } from './parts'
import { stateOf, verb, type CardView } from './view'

const NOTHING = /^(no (matches|files) found|0 (matches|files))/i

function resultLines(text: string): string[] {
  const clean = unwrap(text)
  if (clean === '' || NOTHING.test(clean)) return []
  return clean.split('\n').filter((l) => l.trim() !== '')
}

function search(kind: 'Grep' | 'Glob'): ToolRenderer {
  return (item) => {
    const args = argsOf(item)
    const data = dataOf(item)
    const pattern = firstStr(args, ['pattern', 'query', 'glob'])
    if (pattern === undefined) return null
    const state = stateOf(item)
    const where = firstStr(args, ['path'])
    const mode = firstStr(args, ['output_mode'])

    const lines = state === 'done' ? resultLines(textOf(item)) : []
    const files = num(data.numFiles)
    const found = kind === 'Grep' && mode === 'content' ? lines.length : (files ?? lines.length)
    const unit = kind === 'Grep' && mode === 'content' ? 'match' : 'file'
    const chips: string[] = []
    if (state === 'done')
      chips.push(
        found === 0
          ? 'no results'
          : countLabel(found, unit, `${unit}${unit === 'match' ? 'es' : 's'}`),
      )
    const filter = kind === 'Grep' ? firstStr(args, ['glob', 'type']) : undefined
    if (filter !== undefined) chips.push(filter)
    if (flag(args['-i'])) chips.push('ignore case')

    const view: CardView = {
      label: verb(item, 'Searching', 'Searched'),
      icon: Search,
      summary: where === undefined ? pattern : `${pattern} in ${shortPath(where)}`,
      chips,
      body: (
        <Stack>
          {state === 'error' && <ErrorPane item={item} />}
          {state === 'done' && lines.length > 0 && (
            <CodeBlock
              text={lines.join('\n')}
              lines={30}
              chars={3000}
              wrap={false}
              label="Results"
            />
          )}
          {state === 'done' && lines.length === 0 && (
            <p className="text-xs text-muted-foreground">Nothing found.</p>
          )}
        </Stack>
      ),
    }
    return view
  }
}

export const grepRenderer = search('Grep')
export const globRenderer = search('Glob')
