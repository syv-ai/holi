/** The platform, as the page learns it. `main.tsx` stamps `data-platform` on
 *  the root once; everything else reads it here. */

/** Stamp the root when this is a Mac. macOS draws the window's traffic lights
 *  over the page (`hiddenInset`), so the chrome makes room for them where the
 *  stamp is set (index.css, Window). */
export function stampPlatform(): void {
  if (navigator.userAgent.includes('Mac')) document.documentElement.dataset.platform = 'mac'
}

/** Whether `stampPlatform` marked this as a Mac. Read at the time of use: it
 *  is stamped after the modules load. */
export function isMac(): boolean {
  return document.documentElement.dataset.platform === 'mac'
}

/** What the system's file manager is called, for "Open in …": Finder, or
 *  Explorer when the user agent says Windows, as `stampPlatform` reads a Mac. */
export function fileManagerName(): string {
  if (isMac()) return 'Finder'
  if (navigator.userAgent.includes('Windows')) return 'Explorer'
  return 'file manager'
}
