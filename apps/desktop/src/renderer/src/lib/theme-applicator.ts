/**
 * Writes CSS custom properties onto a root element and remembers what it
 * wrote, so the next apply drops what is no longer wanted and a clear strips
 * everything it owns, and nothing it does not. Driven by `state/theme.ts`.
 */
export class ThemeApplicator {
  /** The custom-property names this applicator currently has set on `root`. */
  private applied: string[] = []

  constructor(private readonly root: HTMLElement) {}

  /**
   * Make `root` carry exactly `vars`: overwrite or add each, and remove any
   * property a previous apply set that is not in `vars` now. Never clears
   * first, so a vault switch does not flash the defaults.
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
