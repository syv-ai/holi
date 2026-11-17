import { compile } from '@mdx-js/mdx'

interface Request {
  id: string
  source: string
}

interface Result {
  id: string
  diagnostics: { message: string; line: number; column: number }[]
}

type Location = { line?: unknown; column?: unknown }
type ParserError = {
  message?: unknown
  position?: { start?: Location } | Location
  place?: { start?: Location } | Location
  line?: unknown
  column?: unknown
}

const root = globalThis as typeof globalThis & {
  __holiMdxReceive?: (encoded: string) => void
  __holiMdxTakeResult?: () => Result | null
  __holiMdxResult?: Result
}

root.__holiMdxReceive = (encoded) => {
  let request: Request
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as Partial<Request>
    if (typeof value.id !== 'string' || typeof value.source !== 'string') return
    request = { id: value.id, source: value.source }
  } catch {
    return
  }
  root.__holiMdxResult = undefined
  void compile(request.source, {
    outputFormat: 'program',
    development: false,
    format: 'mdx',
    jsx: true,
    jsxImportSource: 'react',
    remarkPlugins: [],
    rehypePlugins: [],
    recmaPlugins: [],
  }).then(
    () => {
      root.__holiMdxResult = { id: request.id, diagnostics: [] }
    },
    (error: unknown) => {
      const candidate = (error ?? {}) as ParserError
      const position = candidate.position ?? candidate.place
      const start = position && 'start' in position ? position.start : position
      root.__holiMdxResult = {
        id: request.id,
        diagnostics: [
          {
            message: typeof candidate.message === 'string' ? candidate.message : 'Invalid MDX',
            line:
              typeof start?.line === 'number'
                ? start.line
                : typeof candidate.line === 'number'
                  ? candidate.line
                  : 1,
            column:
              typeof start?.column === 'number'
                ? start.column
                : typeof candidate.column === 'number'
                  ? candidate.column
                  : 1,
          },
        ],
      }
    },
  )
}

root.__holiMdxTakeResult = () => {
  const result = root.__holiMdxResult ?? null
  root.__holiMdxResult = undefined
  return result
}
