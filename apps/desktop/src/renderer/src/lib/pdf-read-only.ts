/**
 * Making a PDF's marks read-only, as pure rules.
 *
 * A whole-document toggle on the viewer's top bar sets or clears the PDF
 * `readOnly` annotation flag on every mark, comment and signature. It is part of
 * the PDF specification (ISO 32000): the viewer honours it by making an
 * annotation unselectable, so it cannot be moved, edited or deleted, and other
 * readers honour it too. Anyone may do either; a mark added afterwards stays
 * editable until the next toggle. There is no record of Holi's own beside the
 * flags: they are the state, read back from the viewer's store.
 *
 * Why a whole-document toggle and not a per-mark one: a `readOnly` annotation
 * cannot be selected, so nothing on the mark itself could clear the flag again.
 *
 * No React, no DOM: `features/files/PdfDocument` consumes this,
 * `test/pdf-read-only.test.ts` pins it.
 */

/** The two commands, one per direction, each shown only when it applies: a
 *  viewer command's label is fixed text, so one toggling command could not
 *  say which way it goes. */
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
 * The document's annotations out of the viewer's store, which is what a
 * command's dynamic state is handed. Read there rather than kept by Holi, so
 * the button follows every change the viewer makes without being told.
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
