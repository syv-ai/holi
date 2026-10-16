/**
 * Read: the file, with the line numbers Claude Code prefixed taken off the text
 * and drawn as a gutter. A picture is a chip, never the bytes.
 */
import { FileText } from 'lucide-react'
import type { ToolRenderer } from '../registry'
import {
  argsOf,
  bytesLabel,
  dataOf,
  firstStr,
  get,
  isRec,
  num,
  shortPath,
  stripLineNumbers,
  textOf,
  unwrap,
} from './coerce'
import { CodeBlock, ErrorPane, ImageChips, Stack, imagesOf } from './parts'
import { stateOf, verb, type CardView } from './view'

export const readRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const path = firstStr(args, ['file_path', 'path', 'notebook_path'])
  if (path === undefined) return null
  const state = stateOf(item)

  const offset = num(args.offset)
  const limit = num(args.limit)
  const pages = firstStr(args, ['pages'])
  const file = get(data, 'file')
  const total = isRec(file) ? num(file.totalLines) : undefined
  const read = isRec(file) ? num(file.numLines) : undefined

  const chips: string[] = []
  if (pages !== undefined) chips.push(`pages ${pages}`)
  else if (offset !== undefined || limit !== undefined) {
    const from = Math.max(1, offset ?? 1)
    chips.push(limit === undefined ? `from line ${from}` : `lines ${from}–${from + limit - 1}`)
  } else if (read !== undefined && total !== undefined && read < total) {
    chips.push(`${read} of ${total} lines`)
  } else if (total !== undefined) chips.push(`${total} lines`)
  const images = imagesOf(item)
  if (images.length > 0 && images[0] !== undefined) {
    chips.push(`image · ${bytesLabel(images[0].bytes)}`)
  }

  // The text, as the model got it; else the structured copy, which has no numbers.
  let text = unwrap(textOf(item))
  let numbered = stripLineNumbers(text)
  if (text === '' && isRec(file) && typeof file.content === 'string') {
    text = file.content
    numbered = { text, first: num(file.startLine) ?? 1 }
  }

  const body =
    state === 'rejected' || state === 'pending' ? null : (
      <Stack>
        {state === 'error' ? (
          <ErrorPane item={item} />
        ) : (
          text !== '' && (
            <CodeBlock
              text={numbered.text}
              lines={200}
              chars={20_000}
              wrap={false}
              label="File"
              {...(numbered.first === null ? {} : { startLine: numbered.first })}
            />
          )
        )}
        <ImageChips item={item} />
      </Stack>
    )

  const view: CardView = {
    label: verb(item, 'Reading', 'Read'),
    icon: FileText,
    summary: shortPath(path),
    chips,
    body: state === 'done' && text === '' && images.length === 0 ? null : body,
  }
  return view
}
