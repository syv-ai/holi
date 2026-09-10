/**
 * The Vault section's headings, shared by the rail and the section itself.
 *
 * Same cycle-breaking reason as `appearance-headings.ts`: `sections.tsx`
 * imports the component, so the component cannot import `sections.tsx` back for
 * the title. Both import this, and the rail's jump target and the rendered
 * heading stay the same string by construction.
 */
export const WHERE_IT_LIVES = 'Where it lives'
export const COLLABORATORS = 'Collaborators'
