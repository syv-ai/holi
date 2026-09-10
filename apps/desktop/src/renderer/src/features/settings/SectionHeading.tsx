/**
 * A heading inside a settings section, and the rail's jump target for it.
 *
 * **The rail declares headings, the section renders them, and this is the one
 * place the id is written.** The rail scrolls by `[data-heading="<id>"]`, so a
 * section that wrote its own markup could silently stop being reachable from
 * the rail while still looking correct. `headingId` is exported so a registry
 * entry derives its ids from the same titles rather than restating them, and a
 * test asserts every declared heading actually renders.
 */

/** A title to its anchor id. Lowercase, non-alphanumerics collapsed to `-`. */
export function headingId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function SectionHeading({
  title,
  blurb,
}: {
  title: string
  blurb?: string
}): React.JSX.Element {
  return (
    // `scroll-mt` because the mode and layer switches are sticky above this:
    // without it a jump parks the heading underneath them.
    <div data-heading={headingId(title)} className="scroll-mt-14 pt-4">
      <h3 className="text-xs font-medium">{title}</h3>
      {blurb !== undefined && <p className="text-[11px] text-muted-foreground">{blurb}</p>}
    </div>
  )
}
