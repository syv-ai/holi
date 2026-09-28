/**
 * The `field` variant's look, shared by `Button`, `SelectTrigger` and `Input`:
 * a value in a labelled row (the frontmatter block), which the row itself
 * frames. So no fill, no hover fill and no edge, in either theme; the row's
 * own tint says it can be pressed. Keyboard focus draws the edgeless ring
 * (ui-system §Focus).
 */
export const FIELD_LOOK =
  'h-8 w-full min-w-0 justify-end rounded-md border-0 bg-transparent px-2 text-xs font-normal shadow-none hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent focus-visible:ring-1 focus-visible:ring-ring md:text-xs'

/**
 * A field you type into, on its own (a name in the tree, a dialog's input): a
 * calm grey fill and no edge. Focus is the caret, blinking where the text goes,
 * so there is no focus edge either; an invalid value tints the fill.
 */
export const TEXT_FIELD_LOOK =
  'rounded-md border-0 bg-muted shadow-none aria-invalid:bg-destructive/15'
