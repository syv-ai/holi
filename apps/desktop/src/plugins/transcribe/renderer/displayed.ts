import { createContext, useContext, useEffect, useState } from 'react'

export const DisplayedContext = createContext(true)
export const useMeetingsDisplayed = (): boolean => useContext(DisplayedContext)

export function useDisplayedNow(stepMs: number): number {
  const displayed = useMeetingsDisplayed()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!displayed) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), stepMs)
    return () => clearInterval(timer)
  }, [displayed, stepMs])
  return now
}
