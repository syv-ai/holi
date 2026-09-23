/**
 * Making a PDF's marks read-only, as pure rules.
 *
 * A whole-document toggle on the viewer's top bar. It sets or clears the PDF
 * `readOnly` annotation flag (ISO 32000), which the viewer honours by making an
 * annotation unselectable and other readers honour too, on every mark, comment
 * and signature. Anyone may do either; new marks stay editable until the next
 * toggle. No record of its own: the flags are the state.
 */
import { describe, expect, it } from 'vitest'
import {
  MAKE_EDITABLE,
  MAKE_READ_ONLY,
  isLockable,
  marksIn,
  readOnlyState,
  withReadOnly,
  withoutReadOnly,
} from '../src/renderer/src/lib/pdf-read-only'

const mark = (type: number, flags: string[] = ['print']) => ({ type, flags })

describe('isLockable', () => {
  it('covers marks, comments and signatures, not the document structure', () => {
    // PdfAnnotationSubtype: TEXT 1, LINK 2, FREETEXT 3, HIGHLIGHT 9, STAMP 13,
    // INK 15, POPUP 16, WIDGET 20.
    for (const t of [1, 3, 9, 13, 15]) expect(isLockable(t)).toBe(true)
    for (const t of [2, 16, 20]) expect(isLockable(t)).toBe(false)
  })
})

describe('the readOnly flag', () => {
  it('is added once and removed without touching the other flags', () => {
    expect(withReadOnly(['print'])).toEqual(['print', 'readOnly'])
    expect(withReadOnly(['print', 'readOnly'])).toEqual(['print', 'readOnly'])
    expect(withReadOnly(undefined)).toEqual(['readOnly'])
    expect(withoutReadOnly(['print', 'readOnly', 'locked'])).toEqual(['print', 'locked'])
    expect(withoutReadOnly(undefined)).toEqual([])
  })
})

describe('readOnlyState', () => {
  it('has nothing to do when there are no marks, only structure', () => {
    expect(readOnlyState([mark(2), mark(20)])).toEqual({ editable: 0, readOnly: 0 })
  })

  it('counts the marks each command would change', () => {
    expect(readOnlyState([mark(9), mark(13, ['print', 'readOnly']), mark(2)])).toEqual({
      editable: 1,
      readOnly: 1,
    })
  })

  it('names two commands, one per direction', () => {
    expect(MAKE_READ_ONLY).toBe('holi:make-marks-read-only')
    expect(MAKE_EDITABLE).toBe('holi:make-marks-editable')
  })
})

describe('marksIn', () => {
  it("reads the document's annotations out of the viewer's store", () => {
    const state = {
      plugins: {
        annotation: {
          documents: {
            doc: {
              byUid: {
                u1: { object: { id: 'a', pageIndex: 0, type: 9, flags: ['print'] } },
                u2: { object: { id: 'b', pageIndex: 3, type: 13, flags: ['readOnly'] } },
              },
            },
          },
        },
      },
    }
    expect(marksIn(state, 'doc')).toEqual([
      { id: 'a', pageIndex: 0, type: 9, flags: ['print'] },
      { id: 'b', pageIndex: 3, type: 13, flags: ['readOnly'] },
    ])
    expect(marksIn(state, 'other')).toEqual([])
    expect(marksIn({}, 'doc')).toEqual([])
  })
})
