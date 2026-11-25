/** Validate a named time zone and normalize its aliases using the runtime's tzdb. */
export function canonicalIanaZone(value: string | null | undefined): string | null {
  // Intl also accepts numeric UTC offsets on some runtimes; those aren't names.
  if (!value || !/^[a-z][a-z\d_+./-]*$/i.test(value)) return null
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return null
  }
}
