/**
 * The document's menu, after the rich-text block's page actions: page layout
 * (full width, small text), a Holi link to the document or to the heading the
 * caret is under (docs/features/holi-links.md), export (Markdown, HTML) and
 * Create vault app. A copy confirms in place on its item; only a failure
 * toasts.
 */
import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  ArrowLeftRightIcon,
  CheckIcon,
  CodeIcon,
  FileTextIcon,
  HashIcon,
  LinkIcon,
  MoreHorizontalIcon,
  SparklesIcon,
  TypeIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type CopyFormat = 'markdown' | 'html' | 'link' | 'heading-link'

// Long enough to read the swap, short enough to copy again.
const COPIED_MS = 1600

export interface DocumentActionsProps {
  editor: Editor | null
  /** The file as it is saved: Copy Markdown copies this, frontmatter and all. */
  markdown: () => string
  fullWidth: boolean
  smallText: boolean
  onFullWidthChange: (fullWidth: boolean) => void
  onSmallTextChange: (smallText: boolean) => void
  /** Null while an agent run is already going, or there is no agent. */
  onCreateVaultApp: (() => void) | null
  /** The document's Holi links; null for a file a teammate could not open
   *  (a local file). `heading` is null above the first heading. */
  holiLinks?: { file: () => string; heading: () => string | null } | null
}

export function DocumentActions({
  editor,
  markdown,
  fullWidth,
  smallText,
  onFullWidthChange,
  onSmallTextChange,
  onCreateVaultApp,
  holiLinks = null,
}: DocumentActionsProps) {
  const [copied, setCopied] = useState<CopyFormat | null>(null)
  const copiedTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])

  async function copyAs(format: CopyFormat) {
    if (!editor) return
    const value =
      format === 'html'
        ? editor.getHTML()
        : format === 'link'
          ? holiLinks?.file()
          : format === 'heading-link'
            ? holiLinks?.heading()
            : markdown()
    if (value === undefined || value === null) return
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      toast.error('Copy failed', {
        description: 'The clipboard could not be written.',
      })
      return
    }
    setCopied(format)
    window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(null), COPIED_MS)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Document actions">
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Page</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={fullWidth}
            onCheckedChange={onFullWidthChange}
            onSelect={(event) => event.preventDefault()}
          >
            <ArrowLeftRightIcon aria-hidden="true" />
            Full Width
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={smallText}
            onCheckedChange={onSmallTextChange}
            onSelect={(event) => event.preventDefault()}
          >
            <TypeIcon aria-hidden="true" />
            Small Text
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {holiLinks ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Share</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={(event) => event.preventDefault()}
                onClick={() => void copyAs('link')}
              >
                {copied === 'link' ? (
                  <CheckIcon aria-hidden="true" />
                ) : (
                  <LinkIcon aria-hidden="true" />
                )}
                {copied === 'link' ? 'Copied' : 'Copy Holi Link'}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(event) => event.preventDefault()}
                disabled={!editor || holiLinks.heading() === null}
                onClick={() => void copyAs('heading-link')}
              >
                {copied === 'heading-link' ? (
                  <CheckIcon aria-hidden="true" />
                ) : (
                  <HashIcon aria-hidden="true" />
                )}
                {copied === 'heading-link' ? 'Copied' : 'Copy Link to Heading'}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Export</DropdownMenuLabel>
          {/* Stays open, so the swap to Copied is seen where it was clicked. */}
          <DropdownMenuItem
            onSelect={(event) => event.preventDefault()}
            disabled={!editor}
            onClick={() => void copyAs('markdown')}
          >
            {copied === 'markdown' ? (
              <CheckIcon aria-hidden="true" />
            ) : (
              <FileTextIcon aria-hidden="true" />
            )}
            {copied === 'markdown' ? 'Copied' : 'Copy Markdown'}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(event) => event.preventDefault()}
            disabled={!editor}
            onClick={() => void copyAs('html')}
          >
            {copied === 'html' ? <CheckIcon aria-hidden="true" /> : <CodeIcon aria-hidden="true" />}
            {copied === 'html' ? 'Copied' : 'Copy HTML'}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={onCreateVaultApp === null} onClick={() => onCreateVaultApp?.()}>
          <SparklesIcon aria-hidden="true" />
          Create vault app
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
