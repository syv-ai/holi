import type { ReactNode } from "react"
import { useShortcutLabel } from "@/composites/shortcut-keys"
import type { Editor } from "@tiptap/react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  type RichTextBlockType,
  type RichTextSnapshot,
} from "./rich-text-state"
import {
  RichTextButton,
  RichTextToggle,
  RichTextToolbarGroup,
} from "./rich-text-toolbar"
import { Undo2Icon, Redo2Icon, TypeIcon, Heading1Icon, Heading2Icon, Heading3Icon, ChevronDownIcon, BoldIcon, ItalicIcon, UnderlineIcon, StrikethroughIcon, CodeIcon } from "lucide-react"

interface ControlProps {
  editor: Editor | null
  state: RichTextSnapshot
}

// Closing a menu hands the caret back to the text, not to the trigger.
function focusEditor(editor: Editor | null) {
  return (event: Event) => {
    event.preventDefault()
    editor?.view.focus()
  }
}

export function RichTextHistory({ editor, state }: ControlProps) {
  return (
    <RichTextToolbarGroup label="History">
      <RichTextButton
        label="Undo"
        shortcut={["mod", "Z"]}
        disabled={!state.canUndo}
        onClick={() => editor?.chain().focus().undo().run()}
      >
        <Undo2Icon aria-hidden="true" />
      </RichTextButton>
      <RichTextButton
        label="Redo"
        shortcut={["mod", "shift", "Z"]}
        disabled={!state.canRedo}
        onClick={() => editor?.chain().focus().redo().run()}
      >
        <Redo2Icon aria-hidden="true" />
      </RichTextButton>
    </RichTextToolbarGroup>
  )
}

interface BlockTypeOption {
  value: RichTextBlockType
  label: string
  icon: ReactNode
  keys: readonly string[]
}

// Whole static glyphs per type, so the trigger can mirror the current block.
const BLOCK_TYPES: BlockTypeOption[] = [
  {
    value: "paragraph",
    label: "Text",
    keys: ["mod", "alt", "0"],
    icon: (
      <TypeIcon aria-hidden="true" />
    ),
  },
  {
    value: "heading-1",
    label: "Heading 1",
    keys: ["mod", "alt", "1"],
    icon: (
      <Heading1Icon aria-hidden="true" />
    ),
  },
  {
    value: "heading-2",
    label: "Heading 2",
    keys: ["mod", "alt", "2"],
    icon: (
      <Heading2Icon aria-hidden="true" />
    ),
  },
  {
    value: "heading-3",
    label: "Heading 3",
    keys: ["mod", "alt", "3"],
    icon: (
      <Heading3Icon aria-hidden="true" />
    ),
  },
]

const isBlockType = (value: unknown): value is RichTextBlockType =>
  BLOCK_TYPES.some((option) => option.value === value)

function setBlockType(editor: Editor | null, value: RichTextBlockType) {
  const chain = editor?.chain().focus()

  if (value === "heading-1") chain?.setHeading({ level: 1 }).run()
  else if (value === "heading-2") chain?.setHeading({ level: 2 }).run()
  else if (value === "heading-3") chain?.setHeading({ level: 3 }).run()
  else chain?.setParagraph().run()
}

function MenuShortcut({ keys }: { keys: readonly string[] }) {
  return <DropdownMenuShortcut>{useShortcutLabel(keys)}</DropdownMenuShortcut>
}

export function RichTextBlockTypeMenu({ editor, state }: ControlProps) {
  const current =
    BLOCK_TYPES.find((option) => option.value === state.blockType) ??
    BLOCK_TYPES[0]!

  // Fixed width on desktop, so the bar never shifts as the label changes;
  // the current block's glyph alone below sm, so the marks stay in view.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Block type, ${current.label}`}
          disabled={!state.editable || state.codeBlock}
          className="shrink-0 justify-between sm:w-28"
          data-toolbar-item=""
        >
          <span className="flex sm:hidden">{current.icon}</span>
          <span className="truncate max-sm:hidden">{current.label}</span>
          <ChevronDownIcon aria-hidden="true" className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-auto"
        onCloseAutoFocus={focusEditor(editor)}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Turn Into</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={state.blockType}
            onValueChange={(value) => {
              if (isBlockType(value)) setBlockType(editor, value)
            }}
          >
            {BLOCK_TYPES.map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                disabled={option.value !== "paragraph" && !state.canHeading}
              >
                {option.icon}
                {option.label}
                <MenuShortcut keys={option.keys} />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function RichTextMarkToggles({ editor, state }: ControlProps) {
  const disabled = !state.canFormat

  return (
    <RichTextToolbarGroup label="Text style">
      <RichTextToggle
        label="Bold"
        shortcut={["mod", "B"]}
        pressed={state.bold}
        disabled={disabled}
        onToggle={() => editor?.chain().focus().toggleBold().run()}
      >
        <BoldIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextToggle
        label="Italic"
        shortcut={["mod", "I"]}
        pressed={state.italic}
        disabled={disabled}
        onToggle={() => editor?.chain().focus().toggleItalic().run()}
      >
        <ItalicIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextToggle
        label="Underline"
        shortcut={["mod", "U"]}
        pressed={state.underline}
        disabled={disabled}
        onToggle={() => editor?.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextToggle
        label="Strikethrough"
        shortcut={["mod", "shift", "S"]}
        pressed={state.strike}
        disabled={disabled}
        onToggle={() => editor?.chain().focus().toggleStrike().run()}
      >
        <StrikethroughIcon aria-hidden="true" />
      </RichTextToggle>
      <RichTextToggle
        label="Inline code"
        shortcut={["mod", "E"]}
        pressed={state.code}
        disabled={!state.canCode}
        onToggle={() => editor?.chain().focus().toggleCode().run()}
      >
        <CodeIcon aria-hidden="true" />
      </RichTextToggle>
    </RichTextToolbarGroup>
  )
}
