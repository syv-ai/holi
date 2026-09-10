/**
 * What a CSS colour actually is, as `#rrggbb`.
 *
 * Needed for one reason only: `<input type="color">` speaks hex and nothing
 * else, so the picker needs a starting point. Everything else in the theme
 * pane paints the raw value and lets the browser resolve it.
 *
 * **The browser does the conversion, not us.** A token resolves to
 * `oklch(14.5% 0 0)`, or to a `color-mix(...)` for the derived ones, and
 * converting either by hand means reimplementing colour spaces. Setting the
 * value as a real `color` property and reading it back makes the engine resolve
 * it to `rgb(...)` — which is a computed value, unlike a custom property, whose
 * `getPropertyValue` hands back the unresolved text.
 */

/** Somewhere off-screen to resolve against. One element, reused: this is called
 *  once per token per render pass, and thirty appends per pass is thirty
 *  layout invalidations for a question with no layout in it. */
let probe: HTMLSpanElement | null = null

function probeElement(): HTMLSpanElement {
  if (probe !== null && probe.isConnected) return probe
  probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  return probe
}

const CHANNELS = /(-?[\d.]+)/g

/**
 * `value` resolved to `#rrggbb`, or `#000000` when it cannot be.
 *
 * The fallback is deliberately silent. This feeds a picker's initial position;
 * a colour that will not resolve — a typo in a hand-written theme, a value
 * behind an unsupported function — should open the picker on black rather than
 * take the pane down.
 */
export function cssColorToHex(value: string): string {
  const el = probeElement()
  el.style.color = ''
  el.style.color = value
  // An unparseable value leaves `color` unset, which computes to the inherited
  // colour rather than to nothing — so a failure here is indistinguishable from
  // success, and both are better than throwing.
  const computed = getComputedStyle(el).color
  const parts = computed.match(CHANNELS)
  if (parts === null || parts.length < 3) return '#000000'
  return `#${parts
    .slice(0, 3)
    .map((n) =>
      Math.max(0, Math.min(255, Math.round(Number(n))))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** The effective value of a custom property on the document root, resolved to
 *  hex. `--divider` is the one that proves this cannot read the property
 *  directly: it resolves to a `color-mix(...)`, which is a colour to the engine
 *  and a string to `getPropertyValue`. */
export function tokenToHex(slug: string): string {
  return cssColorToHex(`var(--${slug})`)
}
