/**
 * Whether an element is wide enough for the meeting's three columns. A width
 * not measured yet (no layout, as in tests) counts as wide.
 */
import { useLayoutEffect, useState, type RefObject } from 'react'

export function useWide(ref: RefObject<HTMLElement | null>, min: number): boolean {
  const [wide, setWide] = useState(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const measure = () => {
      const width = el.getBoundingClientRect().width
      setWide(width === 0 || width >= min)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, min])
  return wide
}
