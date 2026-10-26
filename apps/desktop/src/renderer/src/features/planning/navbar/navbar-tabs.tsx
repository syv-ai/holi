import { Badge } from "@/components/reui/badge"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { TabItem } from "./data"
import { MenuIcon } from "lucide-react"

// ── Navbar tabs (line variant + optional badge; must be used inside Tabs) ──

type NavbarTabsProps = {
  items: TabItem[]
  value: string
  onValueChange: (value: string) => void
}

export function NavbarTabs({ items, value, onValueChange }: NavbarTabsProps) {
  const current = items.find((item) => item.value === value)

  return (
    <>
      {/* Desktop: inline tabs */}
      <TabsList variant="line" className="hidden md:inline-flex">
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.icon}
            {item.label}
            {item.badge != null && (
              <Badge variant="secondary" radius="full">
                {item.badge}
              </Badge>
            )}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* Narrow: a menu of the same tabs */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Choose a view"
            className="md:hidden"
          >
            <MenuIcon data-icon="inline-start" aria-hidden="true" />
            {current?.label}
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-40">
          <DropdownMenuGroup>
            <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
              {items.map((item) => (
                <DropdownMenuRadioItem key={item.value} value={item.value}>
                  {item.icon}
                  {item.label}
                  {item.badge != null && (
                    <Badge
                      variant="secondary"
                      radius="full"
                      className="ml-auto"
                    >
                      {item.badge}
                    </Badge>
                  )}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
