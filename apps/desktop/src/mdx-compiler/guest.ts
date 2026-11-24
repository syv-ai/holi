import { compile } from '@mdx-js/mdx'
import { Parser } from 'acorn'
import jsx from 'acorn-jsx'

interface Request {
  id: string
  source: string
  format?: 'mdx' | 'js' | 'jsx'
}

interface Dependency {
  specifier: string
  line: number
  column: number
}

interface Diagnostic {
  message: string
  line: number
  column: number
}

interface Result {
  id: string
  diagnostics: Diagnostic[]
  dependencies: Dependency[]
}

type Location = { line?: unknown; column?: unknown }
type ParserError = {
  message?: unknown
  loc?: Location & { start?: Location }
  position?: Location & { start?: Location }
  place?: Location & { start?: Location }
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
    request = {
      id: value.id,
      source: value.source,
      format: value.format === 'js' || value.format === 'jsx' ? value.format : 'mdx',
    }
  } catch {
    return
  }
  root.__holiMdxResult = undefined
  const diagnostics: Diagnostic[] = []
  const dependencies: Dependency[] = []
  const inspectDependencies = () => (tree: unknown) => {
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const value = node as Record<string, unknown>
      const location = value.loc as { start?: Location } | undefined
      const start = location?.start
      const line = typeof start?.line === 'number' ? start.line : 1
      const column = typeof start?.column === 'number' ? start.column + 1 : 1
      const type = value.type
      if (
        type === 'ImportDeclaration' ||
        type === 'ExportNamedDeclaration' ||
        type === 'ExportAllDeclaration'
      ) {
        const source = value.source as { type?: unknown; value?: unknown } | null
        if (source?.type === 'Literal' && typeof source.value === 'string') {
          const specifier = source.value
          if (specifier.startsWith('./') || specifier.startsWith('../')) {
            dependencies.push({ specifier, line, column })
          } else {
            diagnostics.push({
              message: `External module "${specifier}" is not allowed; use a relative import.`,
              line,
              column,
            })
          }
        }
      } else if (
        type === 'ImportExpression' ||
        (type === 'CallExpression' &&
          (value.callee as { type?: unknown } | undefined)?.type === 'Import')
      ) {
        diagnostics.push({
          message: 'Dynamic imports are not supported; use a static relative import.',
          line,
          column,
        })
      } else if (
        type === 'MetaProperty' &&
        (value.meta as { name?: unknown } | undefined)?.name === 'import'
      ) {
        diagnostics.push({ message: 'import.meta is not supported.', line, column })
      } else if (
        type === 'CallExpression' &&
        (value.callee as { type?: unknown; name?: unknown } | undefined)?.name === 'require'
      ) {
        diagnostics.push({
          message: 'CommonJS require() is not supported; use a static relative import.',
          line,
          column,
        })
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue
        if (Array.isArray(child)) child.forEach(visit)
        else if (child && typeof child === 'object') visit(child)
      }
    }
    visit(tree)
  }
  if (request.format === 'js' || request.format === 'jsx') {
    try {
      const JavaScriptParser = Parser.extend(jsx())
      const tree = JavaScriptParser.parse(request.source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true,
      })
      inspectDependencies()(tree)
      root.__holiMdxResult = { id: request.id, diagnostics, dependencies }
    } catch (error) {
      const candidate = error as ParserError
      const position = candidate.position ?? candidate.place ?? candidate.loc
      const start = position && 'start' in position ? position.start : position
      root.__holiMdxResult = {
        id: request.id,
        dependencies: [],
        diagnostics: [
          {
            message:
              typeof candidate.message === 'string' ? candidate.message : 'Invalid JavaScript',
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
    }
    return
  }
  void compile(request.source, {
    outputFormat: 'program',
    development: false,
    format: 'mdx',
    jsx: true,
    jsxImportSource: 'react',
    remarkPlugins: [],
    rehypePlugins: [],
    recmaPlugins: [inspectDependencies],
  }).then(
    () => {
      root.__holiMdxResult = { id: request.id, diagnostics, dependencies }
    },
    (error: unknown) => {
      const candidate = (error ?? {}) as ParserError
      const position = candidate.position ?? candidate.place ?? candidate.loc
      const start = position && 'start' in position ? position.start : position
      root.__holiMdxResult = {
        id: request.id,
        dependencies: [],
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
