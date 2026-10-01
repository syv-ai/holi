/**
 * Making a PDF's marks read-only, as pure rules.
 *
 * A whole-document toggle sets or clears the PDF spec's `readOnly` annotation
 * flag (ISO 32000) on every mark, comment and signature; other readers honour
 * it too. The flags are the only state. Whole-document because a `readOnly`
 * annotation cannot be selected, so nothing on it could clear the flag.
 */

/** One command per direction: a viewer command's label is fixed, so one toggle
 *  could not say which way it goes. */
export const MAKE_READ_ONLY = 'holi:make-marks-read-only'
export const MAKE_EDITABLE = 'holi:make-marks-editable'

/** An annotation as far as these rules read one. */
export interface Mark {
  id: string
  pageIndex: number
  type: number
  flags?: string[]
}

/**
 * Marks, comments and signatures, not the document's structure. Links, form
 * widgets and comment popups (`PdfAnnotationSubtype` 2, 20 and 16) belong to
 * the document or to another annotation, and are left as they are.
 */
export function isLockable(type: number): boolean {
  return type !== 2 && type !== 16 && type !== 20
}

export function withReadOnly(flags: readonly string[] | undefined): string[] {
  const list = [...(flags ?? [])]
  return list.includes('readOnly') ? list : [...list, 'readOnly']
}

export function withoutReadOnly(flags: readonly string[] | undefined): string[] {
  return (flags ?? []).filter((flag) => flag !== 'readOnly')
}

/** How many marks each command would change. "Make marks read-only" shows
 *  while any is editable, "Make marks editable" once none is. */
export function readOnlyState(marks: readonly Pick<Mark, 'type' | 'flags'>[]): {
  editable: number
  readOnly: number
} {
  let editable = 0
  let readOnly = 0
  for (const mark of marks) {
    if (!isLockable(mark.type)) continue
    if (mark.flags?.includes('readOnly')) readOnly += 1
    else editable += 1
  }
  return { editable, readOnly }
}

/**
 * The document's annotations out of the viewer's store, so the button follows
 * every change the viewer makes.
 */
export function marksIn(state: unknown, documentId: string): Mark[] {
  const byUid = (
    state as {
      plugins?: {
        annotation?: {
          documents?: Record<string, { byUid?: Record<string, { object?: Mark }> } | undefined>
        }
      }
    }
  )?.plugins?.annotation?.documents?.[documentId]?.byUid
  if (byUid === undefined) return []
  return Object.values(byUid).flatMap((tracked) =>
    tracked.object === undefined ? [] : [tracked.object],
  )
}
