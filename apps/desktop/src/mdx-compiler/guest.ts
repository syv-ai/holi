import { compile } from '@mdx-js/mdx'
import { Parser, tokenizer, tokTypes } from 'acorn'
import jsx from 'acorn-jsx'
import { analyze } from 'eslint-scope'
import {
  MAX_MDX_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_MDX_INSPECTION_DEPENDENCIES,
  MAX_MDX_INSPECTION_DIAGNOSTICS,
  MAX_MDX_SPECIFIER_LENGTH,
  type MdxDiagnostic,
} from '@holi/shared'

interface Request {
  id: string
  source: string
  format?: 'mdx' | 'js' | 'jsx'
  emitArtifact?: boolean
}

interface Dependency {
  specifier: string
  line: number
  column: number
}

interface Result {
  id: string
  diagnostics: MdxDiagnostic[]
  dependencies: Dependency[]
  artifact?: string
}

type Program = Parameters<typeof analyze>[0]

type MarkdownNode = {
  type: string
  name?: string | null
  position?: { start: { line: number; column: number; offset: number }; end: { offset: number } }
  children?: MarkdownNode[]
  attributes?: MarkdownNode[]
  value?: string | MarkdownNode | null
  data?: { estree?: Pick<Program, 'body'> }
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

const commonJsGlobals = new Set(['exports', 'module', 'require'])
const unsupportedImportAttributes =
  'Unsupported import attributes; only plain ECMAScript modules are supported.'

function sourcePosition(location: unknown) {
  const start = (location as { start?: Location } | undefined)?.start
  return {
    line: typeof start?.line === 'number' ? start.line : 1,
    column: typeof start?.column === 'number' ? start.column + 1 : 1,
  }
}

function mdxTagBaseReference(
  node: MarkdownNode,
  input: string,
): Program['body'][number] | undefined {
  if (node.type !== 'mdxJsxFlowElement' && node.type !== 'mdxJsxTextElement') return
  const { name: tagName, position } = node
  if (!tagName || !position) return
  const dot = tagName.indexOf('.')
  if (dot < 0) return
  const name = tagName.slice(0, dot)
  if (!commonJsGlobals.has(name)) return

  // MDX stores the parsed tag name separately from its ESTree fragments. The
  // position starts at `<`; locate the parsed base past any opening-tag trivia.
  const { start, end } = position
  const offset = input.indexOf(name, start.offset + 1)
  if (offset < 0 || offset >= end.offset) return
  const lines = input
    .slice(start.offset, offset)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
  const line = start.line + lines.length - 1
  const column = (lines.length === 1 ? start.column - 1 : 0) + lines.at(-1)!.length
  const range: [number, number] = [offset, offset + name.length]
  return {
    type: 'ExpressionStatement',
    range,
    expression: {
      type: 'Identifier',
      name,
      range,
      loc: { start: { line, column }, end: { line, column: column + name.length } },
    },
  }
}

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
      emitArtifact: value.emitArtifact === true,
    }
  } catch {
    return
  }
  root.__holiMdxResult = undefined
  const diagnostics: MdxDiagnostic[] = []
  const dependencies: Dependency[] = []
  const inspectDeclarations = (body: readonly unknown[], input: string) => {
    for (const node of body) {
      const declaration = node as Record<string, unknown>
      const source = moduleSource(declaration)
      if (!source) continue
      const position = sourcePosition(declaration.loc)
      if (hasImportAttributes(declaration, source.end, input)) {
        if (request.format === 'mdx') {
          // As with other MDX parse failures, do not return a partial set of dependencies.
          throw Object.assign(new SyntaxError(unsupportedImportAttributes), {
            position: declaration.loc,
          })
        }
        diagnostics.push({ message: unsupportedImportAttributes, ...position })
      } else if (source.value.length > MAX_MDX_SPECIFIER_LENGTH) {
        diagnostics.push({ message: 'Module specifier exceeds the length limit.', ...position })
      } else if (/^(?:\.\.?\/|\/(?!\/)|https:\/\/)/i.test(source.value)) {
        // Keep one extra edge so main rejects an over-limit graph rather than using a partial one.
        if (dependencies.length <= MAX_MDX_INSPECTION_DEPENDENCIES)
          dependencies.push({ specifier: source.value, ...position })
      } else {
        diagnostics.push({
          message:
            'Unsupported module specifier; use a relative path or an explicit HTTPS module URL.',
          ...position,
        })
      }
    }
  }
  const inspectProgram = (tree: Program) => {
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const value = node as Record<string, unknown>
      const type = value.type
      if (
        type === 'ImportExpression' ||
        (type === 'CallExpression' &&
          (value.callee as { type?: unknown } | undefined)?.type === 'Import')
      ) {
        diagnostics.push({
          message: 'Dynamic imports are not supported; use a static import.',
          ...sourcePosition(value.loc),
        })
      } else if (
        type === 'MetaProperty' &&
        (value.meta as { name?: unknown } | undefined)?.name === 'import'
      ) {
        diagnostics.push({ message: 'import.meta is not supported.', ...sourcePosition(value.loc) })
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue
        if (Array.isArray(child)) child.forEach(visit)
        else if (child && typeof child === 'object') visit(child)
      }
    }
    visit(tree)
    // In strict ESM, direct eval cannot introduce bindings into the surrounding scope.
    const { globalScope } = analyze(tree, {
      ecmaVersion: 2026,
      sourceType: 'module',
      jsx: true,
      ignoreEval: true,
    })
    const reported = new Set<object>()
    for (const { identifier } of globalScope?.through ?? []) {
      if (!commonJsGlobals.has(identifier.name) || reported.has(identifier)) continue
      reported.add(identifier)
      diagnostics.push({
        message: 'CommonJS is not supported; use ECMAScript modules.',
        ...sourcePosition(identifier.loc),
      })
    }
  }
  if (request.format === 'js' || request.format === 'jsx') {
    try {
      const JavaScriptParser = Parser.extend(jsx())
      const tree = JavaScriptParser.parse(request.source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true,
        ranges: true,
      })
      inspectDeclarations(tree.body, request.source)
      inspectProgram(tree as unknown as Program)
      root.__holiMdxResult = {
        id: request.id,
        diagnostics,
        dependencies,
        ...(request.emitArtifact && diagnostics.length === 0 ? { artifact: request.source } : {}),
      }
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
    jsx: request.emitArtifact ? false : true,
    jsxImportSource: 'react',
    remarkPlugins: [
      () => (tree: MarkdownNode) => {
        // Analyze the original fragments and JSX tag bases as one module so that
        // they share the bindings from every ESM block. Do this before MDX
        // inserts unranged code, drops empty re-exports, or rewrites layouts.
        const body: Program['body'] = []
        // Micromark's offsets exclude an initial BOM.
        const input = request.source.startsWith('\uFEFF') ? request.source.slice(1) : request.source
        const visit = (node: MarkdownNode): void => {
          const statements = node.data?.estree?.body ?? []
          if (node.type === 'mdxjsEsm') inspectDeclarations(statements, input)
          for (const statement of statements) body.push(statement)
          const tagReference = mdxTagBaseReference(node, input)
          if (tagReference) body.push(tagReference)
          node.attributes?.forEach(visit)
          if (node.value && typeof node.value === 'object') visit(node.value)
          node.children?.forEach(visit)
        }
        visit(tree)
        inspectProgram({ type: 'Program', sourceType: 'module', range: [0, input.length], body })
      },
    ],
    rehypePlugins: [],
  }).then(
    (compiled) => {
      // The compiler runs in its isolated offline guest. Return generated code as
      // inert data; callers must not evaluate it in this process.
      root.__holiMdxResult = {
        id: request.id,
        diagnostics,
        dependencies,
        ...(request.emitArtifact && diagnostics.length === 0 ? { artifact: String(compiled) } : {}),
      }
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
  const result = root.__holiMdxResult
  root.__holiMdxResult = undefined
  if (!result) return null
  return {
    ...result,
    diagnostics: result.diagnostics.slice(0, MAX_MDX_INSPECTION_DIAGNOSTICS).map((diagnostic) => ({
      ...diagnostic,
      message: diagnostic.message.slice(0, MAX_MDX_DIAGNOSTIC_MESSAGE_LENGTH),
    })),
  }
}
