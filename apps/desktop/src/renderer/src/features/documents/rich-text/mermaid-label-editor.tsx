import { useId, useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { MermaidTarget } from '@/lib/mermaid-renderer'

export function MermaidLabelEditor({
  target,
  anchor,
  draft,
  error,
  validating,
  onDraftChange,
  onApply,
  onCancel,
  onOpenChange,
}: {
  target: MermaidTarget | null
  anchor: Element | null
  draft: string
  error: string
  validating: boolean
  onDraftChange: (value: string) => void
  onApply: () => void
  onCancel: () => void
  onOpenChange: (open: boolean) => void
}) {
  const inputId = useId()
  const errorId = `${inputId}-error`
  const virtualRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => anchor?.getBoundingClientRect() ?? new DOMRect(),
        contextElement: anchor ?? undefined,
      },
    }),
    [anchor],
  )
  return (
    <Popover open={Boolean(target)} onOpenChange={onOpenChange}>
      {target && anchor ? <PopoverAnchor virtualRef={virtualRef} /> : null}
      <PopoverContent
        onEscapeKeyDown={onCancel}
        onInteractOutside={onCancel}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {target ? (
          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor={inputId}>{target.label}</FieldLabel>
            <Input
              id={inputId}
              value={draft}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onCancel()
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  onApply()
                }
              }}
            />
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={validating} onClick={onApply}>
                Apply
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            </div>
            {error ? <FieldError id={errorId}>{error}</FieldError> : null}
          </Field>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
