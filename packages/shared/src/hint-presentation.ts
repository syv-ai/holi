/** Resolved installed Kbd appearance, never guest-authored CSS or markup. */
export interface HintPresentation {
  backgroundColor: string
  color: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  lineHeight: number
  height: number
  minWidth: number
  paddingInline: number
  paddingBlock: number
  borderRadius: number
  letterSpacing: number
}

const color = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 160 &&
  /^(#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([a-z\d .,%/+\-]+\))$/i.test(
    value,
  )

/** Validate before crossing into an isolated page; properties have fixed meanings. */
export function isHintPresentation(value: unknown): value is HintPresentation {
  if (!value || typeof value !== 'object') return false
  const p = value as HintPresentation
  if (
    !color(p.backgroundColor) ||
    !color(p.color) ||
    typeof p.fontFamily !== 'string' ||
    p.fontFamily.length < 1 ||
    p.fontFamily.length > 256 ||
    !/^[\w\s,'"-]+$/.test(p.fontFamily)
  )
    return false
  return (
    Object.entries({
      fontSize: [8, 48],
      fontWeight: [100, 900],
      lineHeight: [8, 64],
      height: [8, 64],
      minWidth: [0, 64],
      paddingInline: [0, 32],
      paddingBlock: [0, 32],
      borderRadius: [0, 32],
      letterSpacing: [-4, 16],
    }).every(([key, [min, max]]) => {
      const n = p[key as keyof HintPresentation]
      return typeof n === 'number' && Number.isFinite(n) && n >= min! && n <= max!
    }) && Object.keys(p).length === 12
  )
}
