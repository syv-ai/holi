/**
 * A new vault's `README.md`, from its name and the one onboarding question,
 * "What is this vault for?". A plain template, no AI. It is written once, at
 * creation, and belongs to the vault from then on. See docs/features/onboarding.md.
 */

/** The README text: a heading, the answer when there is one, and a folders
 *  section to fill in. */
export function vaultReadme(name: string, purpose = ''): string {
  const answer = purpose.trim()
  return [
    `# ${name}`,
    ...(answer === '' ? [] : ['', answer]),
    '',
    '## Folders',
    '',
    'What each top-level folder holds, one line each.',
    '',
  ].join('\n')
}
