import type { ReactNode } from "react"

export type TabItem = {
  value: string
  label: string
  badge?: number
}

/** One crumb above the project's name. */
export type Crumb = {
  label: string
  icon?: ReactNode
}
