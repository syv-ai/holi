import type { ReactNode } from "react"

export type TabItem = {
  value: string
  label: string
  icon?: ReactNode
  badge?: number
}
