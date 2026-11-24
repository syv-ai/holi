import { compile } from '@mdx-js/mdx'
import { Parser, tokenizer, tokTypes } from 'acorn'
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

function commonJsMember(node: Record<string, unknown>): boolean {
  const owner = node.object as { name?: unknown } | undefined
  const property = node.property as { name?: unknown; value?: unknown } | undefined
  const member = node.computed ? property?.value : property?.name
  return (
    owner?.name === 'exports' ||
    owner?.name === 'require' ||
    (owner?.name === 'module' && (member === 'exports' || member === 'require'))
  )
}

const unsupportedImportAttributes =
  'Unsupported import attributes; only plain ECMAScript modules are supported.'

function moduleSource(node: Record<string, unknown>) {
  if (
    node.type !== 'ImportDeclaration' &&
    node.type !== 'ExportNamedDeclaration' &&
    node.type !== 'ExportAllDeclaration'
  )
    return
  const source = node.source as { type?: unknown; value?: unknown; end?: unknown } | null
  if (source?.type === 'Literal' && typeof source.value === 'string')
    return { value: source.value, end: source.end }
}

function hasImportAttributes(node: Record<string, unknown>, sourceEnd: unknown, input: string) {
  if (
    (Array.isArray(node.attributes) && node.attributes.length > 0) ||
    (Array.isArray(node.assertions) && node.assertions.length > 0)
  )
    return true
  if (typeof sourceEnd !== 'number' || typeof node.end !== 'number' || sourceEnd >= node.end)
    return false
  // Acorn gives both an absent clause and `with {}` an empty attributes array.
  // A plain declaration has only trivia and an optional semicolon after its source literal.
  const { type } = tokenizer(input.slice(sourceEnd, node.end), {
    ecmaVersion: 'latest',
    sourceType: 'module',
  }).getToken()
  return type !== tokTypes.eof && type !== tokTypes.semi
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
      const source = moduleSource(value)
      if (source) {
        // MDX clauses are checked on the original declarations before recma rewrites them.
        if (request.format !== 'mdx' && hasImportAttributes(value, source.end, request.source)) {
          diagnostics.push({ message: unsupportedImportAttributes, line, column })
          return
        }
        const specifier = source.value
        if (/^(?:\.\.?\/|\/(?!\/)|https:\/\/)/i.test(specifier)) {
          dependencies.push({ specifier, line, column })
        } else {
          diagnostics.push({
            message:
              'Unsupported module specifier; use a relative path or an explicit HTTPS module URL.',
            line,
            column,
          })
        }
      } else if (
        type === 'ImportExpression' ||
        (type === 'CallExpression' &&
          (value.callee as { type?: unknown } | undefined)?.type === 'Import')
      ) {
        diagnostics.push({
          message: 'Dynamic imports are not supported; use a static import.',
          line,
          column,
        })
      } else if (
        type === 'MetaProperty' &&
        (value.meta as { name?: unknown } | undefined)?.name === 'import'
      ) {
        diagnostics.push({ message: 'import.meta is not supported.', line, column })
      } else if (
        (type === 'CallExpression' &&
          (value.callee as { name?: unknown } | undefined)?.name === 'require') ||
        (type === 'MemberExpression' && commonJsMember(value))
      ) {
        diagnostics.push({
          message: 'CommonJS is not supported; use ECMAScript modules.',
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
            // Acorn messages can quote source (including a remote module's regexp body).
            message: request.format === 'jsx' ? 'Invalid JSX syntax' : 'Invalid JavaScript syntax',
            line:
              typeof start?.line === 'number'
                ? start.line
                : typeof candidate.line === 'number'
                  ? candidate.line
                  : 1,
            column:
              typeof start?.column === 'number'
                ? start.column + 1
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
    remarkPlugins: [
      () =>
        (tree: {
          children: { type: string; data?: { estree?: { body: Record<string, unknown>[] } } }[]
        }) => {
          // Micromark's offsets exclude an initial BOM. Check before MDX can rewrite
          // a re-export into a layout import and discard the original clause.
          const input = request.source.startsWith('\uFEFF')
            ? request.source.slice(1)
            : request.source
          for (const child of tree.children) {
            if (child.type !== 'mdxjsEsm') continue
            for (const declaration of child.data?.estree?.body ?? []) {
              const source = moduleSource(declaration)
              if (source && hasImportAttributes(declaration, source.end, input)) {
                throw Object.assign(new SyntaxError(unsupportedImportAttributes), {
                  position: declaration.loc,
                })
              }
            }
          }
        },
    ],
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
