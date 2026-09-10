/**
 * The one Appearance heading that is not a theme-token group.
 *
 * A module of its own only to break a cycle: `sections.tsx` imports
 * `ThemeSection` for the component, so `ThemeSection` cannot import
 * `sections.tsx` back for the title. Both import this, and the rail's jump
 * target and the rendered heading stay the same string by construction.
 */
export const LIGHT_AND_DARK = 'Light and dark'
