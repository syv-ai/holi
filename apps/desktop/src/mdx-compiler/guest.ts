import { compile } from '@mdx-js/mdx'

interface Request {
  id: string
  source: string
}

interface Result {
  id: string
  diagnostics: { message: string; line: number; column: number }[]
}

const root = globalThis as typeof globalThis & { __holiMdxResult?: Result }

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = event.data as Partial<Request> | null
  if (
    request === null ||
    typeof request !== 'object' ||
    typeof request.id !== 'string' ||
    typeof request.source !== 'string'
  )
    return
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
      root.__holiMdxResult = { id: request.id!, diagnostics: [] }
    },
    (error: unknown) => {
      const candidate = error as {
        message?: unknown
        position?: { start?: { line?: unknown; column?: unknown } }
      }
      const start = candidate.position?.start
      root.__holiMdxResult = {
        id: request.id!,
        diagnostics: [
          {
            message: typeof candidate.message === 'string' ? candidate.message : 'Invalid MDX',
            line: typeof start?.line === 'number' ? start.line : 1,
            column: typeof start?.column === 'number' ? start.column : 1,
          },
        ],
      }
    },
  )
})
