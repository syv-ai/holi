import type { ReactNode } from "react"

export interface ICard {
  label: string
  icon: ReactNode
  primary: ReactNode
  secondary?: ReactNode
  /** Bottom right: a badge, an avatar group, or nothing. */
  bottom?: ReactNode
}
