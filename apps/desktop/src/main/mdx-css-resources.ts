import postcss from 'postcss'
import { ident, parse, tokenize, tokenTypes, walk, type CssNode } from 'css-tree'
import {
  MAX_MDX_INSPECTION_DEPENDENCIES,
  MAX_MDX_INSPECTION_DIAGNOSTICS,
  MAX_MDX_SPECIFIER_LENGTH,
  type MdxDiagnostic,
} from '@holi/shared'

/**
 * Inspect a CSS stylesheet, not MDX or HTML. No resolution, evaluation or I/O occurs.
 * Positions are one-based UTF-16 source positions. Edges retain source order and duplicates.
 * Any diagnostic invalidates the entire edge set: callers must not traverse a partial graph.
 */
export function inspectMdxCssResources(source: string): {
  diagnostics: MdxDiagnostic[]
  dependencies: { specifier: string; kind: 'css' | 'asset'; line: number; column: number }[]
} {
  const diagnostics: MdxDiagnostic[] = []
  const dependencies: {
    specifier: string
    kind: 'css' | 'asset'
    line: number
    column: number
  }[] = []
  const position = (offset: number) => {
    let low = 0
    let high = lines.length
    while (low + 1 < high) {
      const middle = (low + high) >>> 1
      if (lines[middle]! <= offset) low = middle
      else high = middle
    }
    return { line: low + 1, column: offset - lines[low]! + 1 }
  }
  const lines = [0]
  const report = (message: string, offset = 0) => {
    if (diagnostics.length < MAX_MDX_INSPECTION_DIAGNOSTICS)
      diagnostics.push({ message, ...position(offset) })
  }
  // Match the graph's per-file byte limit before allocating either parser's tree.
  if (source.length > 256 * 1024 || Buffer.byteLength(source) > 256 * 1024) {
    report('CSS source exceeds the inspection size limit.')
    return { diagnostics, dependencies: [] }
  }
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lines.push(i + 1)
  let offset = 0
  try {
    // Bound parser work and recursion using CSS tokens, never characters in strings/comments.
    const stack: number[] = []
    let tokens = 0
    tokenize(source, (type, start) => {
      offset = start
      if (++tokens > 10_000) throw new Error('CSS inspection work limit reached.')
      if (type === tokenTypes.BadString || type === tokenTypes.BadUrl)
        throw new Error('Malformed CSS string or URL.')
      if (type === tokenTypes.Function || type === tokenTypes.LeftParenthesis)
        stack.push(tokenTypes.RightParenthesis)
      else if (type === tokenTypes.LeftCurlyBracket) stack.push(tokenTypes.RightCurlyBracket)
      else if (type === tokenTypes.LeftSquareBracket) stack.push(tokenTypes.RightSquareBracket)
      else if (
        type === tokenTypes.RightParenthesis ||
        type === tokenTypes.RightCurlyBracket ||
        type === tokenTypes.RightSquareBracket
      ) {
        if (stack.pop() !== type) throw new Error('Unbalanced CSS delimiters.')
      }
      if (stack.length > 128) throw new Error('CSS nesting limit reached.')
    })
    if (stack.length) throw new Error('Unclosed CSS delimiter.')
    offset = 0
    const root = postcss.parse(source, { from: undefined })
    const add = (specifier: string, kind: 'css' | 'asset', at: number) => {
      if (
        !specifier.trim() ||
        specifier.startsWith('#') ||
        /^(?:data|blob):/i.test(specifier.trim()) ||
        /[\u0000-\u001f\u007f]/.test(specifier)
      ) {
        report('Unsupported CSS resource URL.', at)
      } else if (specifier.length > MAX_MDX_SPECIFIER_LENGTH) {
        report('CSS resource specifier exceeds the length limit.', at)
      } else if (dependencies.length >= MAX_MDX_INSPECTION_DEPENDENCIES) {
        report('CSS resource edge limit reached.', at)
      } else dependencies.push({ specifier, kind, ...position(at) })
    }
    const inspect = (value: string, base: number, isImport: boolean) => {
      offset = base
      const tree = parse(value, {
        context: isImport ? 'atrulePrelude' : 'value',
        atrule: isImport ? 'import' : undefined,
        positions: true,
        onParseError(error) {
          throw error
        },
      })
      const at = (node: CssNode) => base + (node.loc?.start.offset ?? 0)
      if (isImport) {
        const first = tree.type === 'AtrulePrelude' ? tree.children.first : null
        if (!first || (first.type !== 'String' && first.type !== 'Url')) {
          report('CSS @import requires a static string or URL.', base)
          return
        }
        add(first.value, 'css', at(first))
      } else {
        walk(tree, (node) => {
          if (node.type === 'Url') add(node.value, 'asset', at(node))
          else if (
            node.type === 'Function' &&
            ['image-set', '-webkit-image-set'].includes(ident.decode(node.name).toLowerCase())
          ) {
            // Only direct strings are image candidates; strings in type() are MIME hints.
            node.children.forEach((child) => {
              if (child.type === 'String') add(child.value, 'asset', at(child))
            })
          } else if (node.type === 'Raw') report('Unsupported CSS resource syntax.', at(node))
          else if (node.type === 'Function' && ident.decode(node.name).toLowerCase() === 'url') {
            // Escaped function names are not recognized as Url by css-tree. Only a
            // single parsed string is unambiguously static in that spelling.
            const child = node.children.first
            if (node.children.size === 1 && child?.type === 'String')
              add(child.value, 'asset', at(node))
            else report('CSS URL requires a static value.', at(node))
          }
        })
      }
    }
    root.walk((node) => {
      if (diagnostics.length >= MAX_MDX_INSPECTION_DIAGNOSTICS) return false
      const start = node.source?.start?.offset ?? 0
      if (node.type === 'atrule' && ident.decode(node.name).toLowerCase() === 'import') {
        inspect(
          node.raws.params?.raw ?? node.params,
          start + 1 + node.name.length + (node.raws.afterName?.length ?? 0),
          true,
        )
      } else if (node.type === 'decl') {
        inspect(
          node.raws.value?.raw ?? node.value,
          start + node.prop.length + (node.raws.between?.length ?? 0),
          false,
        )
      }
    })
  } catch (error) {
    // Parser messages may contain source text; return a bounded, inert diagnostic instead.
    const location = error as { line?: number; column?: number; offset?: number }
    if (typeof location.offset === 'number') offset += location.offset
    if (typeof location.line === 'number' && typeof location.column === 'number') {
      // PostCSS errors are stylesheet-relative; css-tree offsets are value-relative.
      if (!('offset' in location)) {
        offset = (lines[location.line - 1] ?? 0) + location.column - 1
      }
    }
    report('CSS is malformed, unsupported, or exceeds inspection limits.', offset)
  }
  return { diagnostics, dependencies: diagnostics.length ? [] : dependencies }
}
