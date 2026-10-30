/**
 * The rich-text block's format bubble for a document: block type, marks,
 * highlight and link over a selection, without alignment (markdown cannot
 * keep it), and an Ask AI menu: quick commands, or the person's own
 * instruction, that hand the selected passage to the document agent to
 * rewrite, and Start chat, a new agent session about the passage.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { EditorState } from '@tiptap/pm/state'
import { isTextSelection, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import {
  ChevronDownIcon,
  MessageCircleIcon,
  MessageSquarePlusIcon,
  MinimizeIcon,
  PencilLineIcon,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

import { AgentPrompt } from './agent-prompt'
import { extraSelections } from './multi-cursor'

const FORMAT_BUBBLE_KEY = 'documentFormatBubble'

const FORMAT_BUBBLE_OPTIONS = { placement: 'top', offset: 8 } as const

/** The quick commands: what the menu says, and the instruction the agent is
 *  given for the passage, as a person would have typed it. */
const QUICK_COMMANDS = [
  {
    id: 'improve',
    label: 'Improve writing',
    instruction: 'Improve the writing',
    icon: WandSparklesIcon,
  },
  {
    id: 'grammar',
    label: 'Fix spelling and grammar',
    instruction: 'Fix the spelling and grammar',
    icon: SpellCheckIcon,
  },
  {
    id: 'simplify',
    label: 'Simplify',
    instruction: 'Simplify the language',
    icon: MinimizeIcon,
  },
  { id: 'shorter', label: 'Make shorter', instruction: 'Make it shorter', icon: ScissorsIcon },
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
  onQuickCommand: ((instruction: string, passage: string) => void) | null
  /** Start a conversation about the passage; null when none can start. */
  onStartChat?: ((passage: string) => void) | null
  /** Start a comment thread on the selection; null when the note takes none. */
  onComment?: (() => void) | null
}

export function DocumentFormatBubble({
  editor,
  linkOpen,
  onLinkOpenChange,
  onQuickCommand,
  onStartChat = null,
  onComment = null,
}: DocumentFormatBubbleProps) {
  const state = useRichTextState(editor)
  /** The passage the person's own instruction is for, taken when its prompt
   *  opened; null while it is closed. */
  const [customPassage, setCustomPassage] = useState<string | null>(null)
  /** Set as the menu closes into the prompt, so it leaves focus to the prompt. */
  const openingCustomRef = useRef(false)
  /** Set when the prompt closes because the person clicked elsewhere, so
   *  focus stays where they clicked rather than going back to the text. */
  const dismissedOutsideRef = useRef(false)
  // With no agent to ask the prompt is gone, so its passage must not keep
  // the bubble held open.
  if (onQuickCommand === null && customPassage !== null) setCustomPassage(null)
  const holdOpen = linkOpen || customPassage !== null
  const holdOpenRef = useRef(holdOpen)

  useLayoutEffect(() => {
    holdOpenRef.current = holdOpen
  }, [holdOpen])

  // Stable identity: a new function would re-register the plugin options.
  const shouldShow = useCallback(
    ({ editor: current, element, state: doc, from, to }: ShouldShowProps) => {
      // The bubble's debounced check can outlive the editor (a closed tab).
      if (current.isDestroyed || !current.isEditable) return false
      if (holdOpenRef.current) return true
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

  const selectedPassage = () => {
    const { from, to } = editor.state.selection
    return editor.state.doc.textBetween(from, to, '\n\n').trim()
  }

  const runCommand = (instruction: string) => {
    const passage = selectedPassage()
    if (passage !== '') onQuickCommand?.(instruction, passage)
  }

  const startChat = () => {
    const passage = selectedPassage()
    if (passage !== '') onStartChat?.(passage)
  }

  const openCustom = () => {
    const passage = selectedPassage()
    if (passage === '') return
    openingCustomRef.current = true
    setCustomPassage(passage)
  }

  const submitCustom = (instruction: string) => {
    const passage = customPassage
    setCustomPassage(null)
    if (passage !== null) onQuickCommand?.(instruction, passage)
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
        holdOpen={holdOpen}
      >
        {onQuickCommand ? (
          <>
            <Popover
              open={customPassage !== null}
              onOpenChange={(open) => {
                if (!open) setCustomPassage(null)
              }}
            >
              <DropdownMenu>
                <PopoverAnchor asChild>
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
                </PopoverAnchor>
                <DropdownMenuContent
                  align="start"
                  className="w-56"
                  onCloseAutoFocus={(event) => {
                    // The prompt takes focus, not the trigger.
                    if (openingCustomRef.current) event.preventDefault()
                    openingCustomRef.current = false
                  }}
                >
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Rewrite the selection</DropdownMenuLabel>
                    {QUICK_COMMANDS.map((command) => (
                      <DropdownMenuItem
                        key={command.id}
                        onClick={() => runCommand(command.instruction)}
                      >
                        <command.icon aria-hidden="true" />
                        {command.label}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem onClick={openCustom}>
                      <PencilLineIcon aria-hidden="true" />
                      Custom instruction…
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  {onStartChat ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={startChat}>
                        <MessageCircleIcon aria-hidden="true" />
                        Start chat
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
              <PopoverContent
                align="start"
                side="top"
                variant="flush"
                aria-label="Custom instruction"
                onOpenAutoFocus={() => {
                  dismissedOutsideRef.current = false
                }}
                onInteractOutside={() => {
                  dismissedOutsideRef.current = true
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault()
                  // Back to the text, the passage still selected, unless the
                  // person clicked somewhere else.
                  if (!dismissedOutsideRef.current) editor.view.focus()
                }}
              >
                {/* Mounts per open, so the field always starts empty. */}
                <AgentPrompt
                  heading="Ask Sonnet to change the selection"
                  placeholder="Make it more formal, turn it into a list…"
                  onSubmit={submitCustom}
                  onCancel={() => setCustomPassage(null)}
                />
              </PopoverContent>
            </Popover>
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
