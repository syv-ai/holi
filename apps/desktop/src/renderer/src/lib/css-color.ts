/**
 * What a CSS colour actually is, as `#rrggbb`.
 *
 * Only for `<input type="color">`, which speaks hex alone; everything else
 * paints the raw value.
 *
 * The browser converts: set the value as a real `color` and read the computed
 * value back. A custom property's `getPropertyValue` returns unresolved text.
 */

/** One reused off-screen element, to avoid a layout invalidation per token. */
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
 * Silent on purpose: an unresolvable colour opens the picker on black rather
 * than taking the pane down.
 */
export function cssColorToHex(value: string): string {
  const el = probeElement()
  el.style.color = ''
  el.style.color = value
  // An unparseable value computes to the inherited colour, indistinguishable
  // from success; either beats throwing.
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

/** A root custom property's effective value as hex. Resolved through `color`,
 *  since a `color-mix(...)` token is only a string to `getPropertyValue`. */
export function tokenToHex(slug: string): string {
  return cssColorToHex(`var(--${slug})`)
}
