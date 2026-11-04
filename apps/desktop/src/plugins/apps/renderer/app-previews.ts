/**
 * Each app's preview for its card on the Apps page (docs/features/vault-apps.md,
 * Previews): taken by `AppFrame` from the frame once the app has loaded and
 * settled, kept by main on this machine, read back by the card.
 *
 * Taking one is a picture of the window cut to the frame, so it is taken only
 * while the frame is what the window shows there: the page visible, and the
 * frame the topmost element at its centre and near each corner, so a menu,
 * a dialog or a popover over it is never kept as the app's picture.
 */
import { atom } from 'jotai'
import { activeRemoteAtom } from '@/plugin-api'
import { appsCap } from './apps-cap'

/** How long after its document loads an app is left to draw itself (fetch
 *  its records, lay out its charts) before its picture is taken. */
export const PREVIEW_SETTLE_MS = 1_500

const bump =
  (id: string) =>
  (all: Readonly<Record<string, number>>): Record<string, number> => ({
    ...all,
    [id]: (all[id] ?? 0) + 1,
  })

/** Bumped for an app whenever its picture is taken or let go: a card reads
 *  its preview again when this moves. */
export const previewVersionsAtom = atom<Readonly<Record<string, number>>>({})

/** Asks a mounted frame to take its app's picture now, by bundle. */
export const previewRequestsAtom = atom<Readonly<Record<string, number>>>({})

/** A picture of the app was kept. */
export const previewTakenAtom = atom(null, (_get, set, id: string) =>
  set(previewVersionsAtom, bump(id)),
)

/** Refresh preview: let the picture go, and ask any frame showing the app
 *  to take it again. With none, the card shows the icon until the app next
 *  runs. */
export const refreshPreviewAtom = atom(null, async (get, set, id: string): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  await appsCap.forgetPreview(remote, { bundle: id })
  set(previewVersionsAtom, bump(id))
  set(previewRequestsAtom, bump(id))
})

/** Whether `frame` is what the window shows across its rect: true when no
 *  other element is over its centre or inside its corners. The corners are
 *  probed 16px in, past the invisible hit areas of the panes' resize
 *  handles, which overlap a frame's edge without drawing over it. */
export function frameIsUnobscured(frame: HTMLElement): boolean {
  if (document.visibilityState !== 'visible') return false
  const r = frame.getBoundingClientRect()
  if (r.width < 64 || r.height < 64) return false
  const inset = 16
  const points: [number, number][] = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + inset, r.top + inset],
    [r.right - inset, r.top + inset],
    [r.left + inset, r.bottom - inset],
    [r.right - inset, r.bottom - inset],
  ]
  return points.every(([x, y]) => document.elementFromPoint(x, y) === frame)
}
