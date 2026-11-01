import type { ReactNode } from 'react'

import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { hotkeyLabels } from '@/lib/hotkey'
import { isMac } from '@/lib/platform'

/**
 * A menu written once and drawn twice: as the tree's right-click menu and as
 * the ⋯ button's dropdown, which is the keyboard's way to the same actions.
 */
export type MenuAction =
  | {
      kind: 'item'
      label: string
      icon?: ReactNode
      shortcut?: string
      disabled?: boolean
      destructive?: boolean
      run: () => void
    }
  | { kind: 'check'; label: string; checked: boolean; toggle: () => void }
  | { kind: 'sub'; label: string; icon?: ReactNode; items: MenuAction[] }
  | { kind: 'separator' }

export function ContextMenuActions({ actions }: { actions: MenuAction[] }) {
  return actions.map((action, index) => {
    switch (action.kind) {
      case 'separator':
        return <ContextMenuSeparator key={index} />
      case 'check':
        return (
          <ContextMenuCheckboxItem
            key={index}
            checked={action.checked}
            onCheckedChange={action.toggle}
          >
            {action.label}
          </ContextMenuCheckboxItem>
        )
      case 'sub':
        return (
          <ContextMenuSub key={index}>
            <ContextMenuSubTrigger>
              {action.icon}
              {action.label}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="max-h-72 w-52 overflow-y-auto">
              <ContextMenuActions actions={action.items} />
            </ContextMenuSubContent>
          </ContextMenuSub>
        )
      case 'item':
        return (
          <ContextMenuItem
            key={index}
            variant={action.destructive ? 'destructive' : 'default'}
            disabled={action.disabled}
            onSelect={action.run}
          >
            {action.icon}
            {action.label}
            {action.shortcut ? (
              <ContextMenuShortcut>{keyText(action.shortcut)}</ContextMenuShortcut>
            ) : null}
          </ContextMenuItem>
        )
    }
  })
}

export function DropdownMenuActions({ actions }: { actions: MenuAction[] }) {
  return actions.map((action, index) => {
    switch (action.kind) {
      case 'separator':
        return <DropdownMenuSeparator key={index} />
      case 'check':
        return (
          <DropdownMenuCheckboxItem
            key={index}
            checked={action.checked}
            onCheckedChange={action.toggle}
          >
            {action.label}
          </DropdownMenuCheckboxItem>
        )
      case 'sub':
        return (
          <DropdownMenuSub key={index}>
            <DropdownMenuSubTrigger>
              {action.icon}
              {action.label}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
              <DropdownMenuActions actions={action.items} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      case 'item':
        return (
          <DropdownMenuItem
            key={index}
            variant={action.destructive ? 'destructive' : 'default'}
            disabled={action.disabled}
            onSelect={action.run}
          >
            {action.icon}
            {action.label}
            {action.shortcut ? (
              <DropdownMenuShortcut>{keyText(action.shortcut)}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        )
    }
  })
}

/** A key spec as it reads on this platform: `⌥⌘C`, or `Ctrl Alt C`. */
function keyText(spec: string): string {
  const mac = isMac()
  return hotkeyLabels(spec, mac).join(mac ? '' : ' ')
}
