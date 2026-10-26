/**
 * The rich-text block's format bubble for a document: block type, marks,
 * highlight and link over a selection, without alignment (markdown cannot
 * keep it), and an Ask AI menu of quick commands that hand the selected
 * passage to the document agent.
 */
import { useCallback, useLayoutEffect, useRef } from 'react'
import type { EditorState } from '@tiptap/pm/state'
import { isTextSelection, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import {
  ChevronDownIcon,
  MessageSquarePlusIcon,
  MinimizeIcon,
  SparklesIcon,
  SpellCheckIcon,
  WandSparklesIcon,
  ScissorsIcon,
} from 'lucide-react'

import { RichTextBubbleBar } from '@/features/documents/rich-text/rich-text-bubble-bar'
import {
  RichTextBlockTypeMenu,
  RichTextMarkToggles,
} from '@/features/documents/rich-text/rich-text-controls'
import { RichTextHighlightPopover } from '@/features/documents/rich-text/rich-text-highlight'
import { RichTextLinkPopover } from '@/features/documents/rich-text/rich-text-link'
import { useRichTextState } from '@/features/documents/rich-text/rich-text-state'
import {
  RichTextToolbarGroup,
  RichTextToolbarSeparator,
} from '@/features/documents/rich-text/rich-text-toolbar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { extraSelections } from './multi-cursor'

const FORMAT_BUBBLE_KEY = 'documentFormatBubble'

const FORMAT_BUBBLE_OPTIONS = { placement: 'top', offset: 8 } as const

/** The quick commands: what the menu says, and the verb the agent is given
 *  ("In `x.md`, <verb> this passage"). */
const QUICK_COMMANDS = [
  {
    id: 'improve',
    label: 'Improve writing',
    verb: 'improve the writing of',
    icon: WandSparklesIcon,
  },
  {
    id: 'grammar',
    label: 'Fix spelling and grammar',
    verb: 'fix the spelling and grammar of',
    icon: SpellCheckIcon,
  },
  { id: 'simplify', label: 'Simplify', verb: 'simplify the language of', icon: MinimizeIcon },
  { id: 'shorter', label: 'Make shorter', verb: 'shorten', icon: ScissorsIcon },
] as const

interface ShouldShowProps {
  editor: Editor
  element: HTMLElement
  state: EditorState
  from: number
  to: number
}

interface DocumentFormatBubbleProps {
  editor: Editor
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
  /** Null when there is no agent to ask. */
  onQuickCommand: ((verb: string, passage: string) => void) | null
  /** Start a comment thread on the selection; null when the note takes none. */
  onComment?: (() => void) | null
}

export function DocumentFormatBubble({
  editor,
  linkOpen,
  onLinkOpenChange,
  onQuickCommand,
  onComment = null,
}: DocumentFormatBubbleProps) {
  const state = useRichTextState(editor)
  const linkOpenRef = useRef(linkOpen)

  useLayoutEffect(() => {
    linkOpenRef.current = linkOpen
  }, [linkOpen])

  // Stable identity: a new function would re-register the plugin options.
  const shouldShow = useCallback(
    ({ editor: current, element, state: doc, from, to }: ShouldShowProps) => {
      // The bubble's debounced check can outlive the editor (a closed tab).
      if (current.isDestroyed || !current.isEditable) return false
      if (linkOpenRef.current) return true
      if (!isTextSelection(doc.selection) || doc.selection.empty) return false
      // Marks would reach only the newest of several ⌘D selections.
      if (extraSelections(doc).length > 0) return false
      if (!doc.doc.textBetween(from, to).trim()) return false
      if (current.isActive('codeBlock') || current.isActive('table') || current.isActive('link')) {
        return false
      }
      return current.view.hasFocus() || element.contains(document.activeElement)
    },
    [],
  )

  const runCommand = (verb: string) => {
    const { from, to } = editor.state.selection
    const passage = editor.state.doc.textBetween(from, to, '\n\n').trim()
    if (passage !== '') onQuickCommand?.(verb, passage)
  }

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={FORMAT_BUBBLE_KEY}
      shouldShow={shouldShow}
      options={FORMAT_BUBBLE_OPTIONS}
      className="z-50"
    >
      <RichTextBubbleBar
        editor={editor}
        pluginKey={FORMAT_BUBBLE_KEY}
        label="Format"
        holdOpen={linkOpen}
      >
        {onQuickCommand ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Ask AI"
                  className="text-primary shrink-0"
                  data-toolbar-item=""
                >
                  <SparklesIcon aria-hidden="true" />
                  Ask AI
                  <ChevronDownIcon aria-hidden="true" className="opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Rewrite the selection</DropdownMenuLabel>
                  {QUICK_COMMANDS.map((command) => (
                    <DropdownMenuItem key={command.id} onClick={() => runCommand(command.verb)}>
                      <command.icon aria-hidden="true" />
                      {command.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <RichTextToolbarSeparator />
          </>
        ) : null}
        <RichTextBlockTypeMenu editor={editor} state={state} />
        <RichTextToolbarSeparator />
        <RichTextMarkToggles editor={editor} state={state} />
        <RichTextToolbarSeparator />
        <RichTextToolbarGroup label="Annotate">
          <RichTextHighlightPopover editor={editor} state={state} />
          <RichTextLinkPopover
            editor={editor}
            state={state}
            open={linkOpen}
            onOpenChange={onLinkOpenChange}
          />
          {onComment ? (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              data-toolbar-item=""
              onClick={onComment}
            >
              <MessageSquarePlusIcon aria-hidden="true" />
              Comment
            </Button>
          ) : null}
        </RichTextToolbarGroup>
      </RichTextBubbleBar>
    </BubbleMenu>
  )
}
