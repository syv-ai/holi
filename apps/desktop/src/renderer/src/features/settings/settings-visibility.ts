import { createContext, useContext } from 'react'

export const SettingsVisibilityContext = createContext(true)

export function useSettingsVisible(): boolean {
  return useContext(SettingsVisibilityContext)
}
