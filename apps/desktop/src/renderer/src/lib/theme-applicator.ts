/**
 * Writes a set of CSS custom properties onto a root element and remembers what
 * it wrote, so the next apply can drop whatever is no longer wanted and a clear
 * can strip everything it owns — and nothing it doesn't.
 *
 * This is the one genuinely fiddly part of theming (diff without flashing the
 * defaults, clear on the way out) pulled out of the React hook into a plain
 * object, so it can be tested with a bare element and no framework. The hook
 * (`state/theme.ts`) is the humble shell that drives it from atoms + tRPC.
 */
export class ThemeApplicator {
  /** The custom-property names this applicator currently has set on `root`. */
  private applied: string[] = []

  constructor(private readonly root: HTMLElement) {}

  /**
   * Make `root` carry exactly `vars`: overwrite or add each, and remove any
   * property a previous apply set that is not in `vars` now. It never clears
   * first, so re-theming (a vault switch) doesn't flash the defaults, and it
   * only ever touches properties it set itself.
   */
  apply(vars: Record<string, string>): void {
    const next = new Set(Object.keys(vars))
    for (const name of this.applied) {
      if (!next.has(name)) this.root.style.removeProperty(name)
    }
    for (const [name, value] of Object.entries(vars)) {
      this.root.style.setProperty(name, value)
    }
    this.applied = Object.keys(vars)
  }

  /** Remove every property this applicator set (leaving the theme entirely). */
  clear(): void {
    this.apply({})
  }
}
