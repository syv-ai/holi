/**
 * What each open tab looks like, as a small picture: the previews the nav
 * menu's cards of open tabs show (`features/nav/OpenTabs`).
 *
 * A tab can only be photographed while it is on screen (an app is a page in a
 * frame, which nothing but the window's own pixels can show), so the tab each
 * pane is showing is captured a moment after it arrives, once more when it has
 * had time to load, and now and then while it stays. A tab that has never been
 * seen has no picture, and its card says so with its icon. Never while something
 * floats over the panes (a card, the stack of agents' fan, a dialog), which
 * would be in the picture.
 */
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { placedTabs, workspaceAtom } from './panes'
import { tabKey } from '@/composites/tab-look'

/** Each tab's picture, a data URL, by `tabKey`. */
export const tabThumbsAtom = atom<ReadonlyMap<string, string>>(new Map())

/** Pixels wide. A card shows them about 150 CSS pixels across. */
const THUMB_WIDTH = 360
/** After a tab arrives: once it has drawn, once it has probably loaded, once a slow app has. */
const SETTLE_MS = [700, 2600, 6000]
/** While it stays. */
const REFRESH_MS = 12_000

/** Something floats over the panes, and would be photographed with them. */
const OVER_PANES =
  '[data-slot="hover-card-content"], [data-agent-stack][data-open], [role="dialog"], [role="menu"]'

export function useTabThumbnails(enabled: boolean): void {
  const workspace = useAtomValue(workspaceAtom)
  const setThumbs = useSetAtom(tabThumbsAtom)
  const open = placedTabs(workspace)
  const showing = open
    .filter((p) => p.showing)
    .map((p) => tabKey(p.tab))
    .sort()
    .join('\n')
  const all = open.map((p) => tabKey(p.tab)).join('\n')

  // A tab that was closed takes its picture with it.
  useEffect(() => {
    const keep = new Set(all === '' ? [] : all.split('\n'))
    setThumbs((prev) => {
      const next = new Map([...prev].filter(([key]) => keep.has(key)))
      return next.size === prev.size ? prev : next
    })
  }, [all, setThumbs])

  useEffect(() => {
    const capture = window.holi?.capturePage
    if (!enabled || capture === undefined || showing === '') return
    const keys = showing.split('\n')
    let stopped = false
    const take = (): void => {
      if (stopped || document.hidden || document.querySelector(OVER_PANES) !== null) return
      for (const key of keys) {
        const body = [...document.querySelectorAll<HTMLElement>('[data-pane-body]')].find(
          (el) => el.dataset['tabKey'] === key,
        )
        if (body === undefined) continue
        const r = body.getBoundingClientRect()
        if (r.width < 80 || r.height < 60) continue
        void capture({ x: r.x, y: r.y, width: r.width, height: r.height }, THUMB_WIDTH).then(
          (url) => {
            if (stopped || url === null) return
            setThumbs((prev) => new Map(prev).set(key, url))
          },
          () => {},
        )
      }
    }
    const timers = SETTLE_MS.map((ms) => setTimeout(take, ms))
    const every = setInterval(take, REFRESH_MS)
    return () => {
      stopped = true
      timers.forEach(clearTimeout)
      clearInterval(every)
    }
  }, [enabled, showing, setThumbs])
}
