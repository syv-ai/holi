/** Escape a JS string for a Typst double-quoted string literal. Backslash first,
 * then quote, so the escape characters themselves aren't re-escaped. */
export function typstString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** A flat string→string map as a Typst dictionary literal. Empty → `(:)` (the
 * empty-dict literal; `()` is the empty array in Typst). Keys are assumed to be
 * valid Typst identifiers — they come from a template's declared `fields`. */
export function typstDict(meta: Record<string, string>): string {
  const entries = Object.entries(meta)
  if (entries.length === 0) return '(:)'
  return `(${entries.map(([k, v]) => `${k}: ${typstString(v)}`).join(', ')})`
}

export interface WrapperInput {
  /** Absolute `.holi/templates/<name>/`. */
  templateDir: string
  /** Absolute path to the note being rendered. */
  notePath: string
  /** Absolute `<templateDir>/assets`. */
  assetsDir: string
  /** Metadata dict passed through to the template's `doc`. */
  meta: Record<string, string>
}

/**
 * The tiny Typst program the engine compiles in a temp dir: import the
 * template's `doc` function and call it. Every path is absolute, so
 * `typst compile … --root /` can read the note and template even though the
 * wrapper itself lives in an unrelated temp directory.
 */
export function composeWrapper({ templateDir, notePath, assetsDir, meta }: WrapperInput): string {
  return (
    `#import ${typstString(`${templateDir}/template.typ`)}: doc\n` +
    `#doc(${typstString(notePath)}, meta: ${typstDict(meta)}, assets: ${typstString(assetsDir)})\n`
  )
}
