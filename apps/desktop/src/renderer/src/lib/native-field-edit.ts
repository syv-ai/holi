export type NativeField = HTMLInputElement | HTMLTextAreaElement

export function supportsNativeFieldSelection(field: NativeField): boolean {
  return (
    field instanceof HTMLTextAreaElement || ['text', 'search', 'url', 'tel'].includes(field.type)
  )
}

/** Edit through Chromium's editing command so the browser owns the undo history. */
export function nativeFieldEdit(
  field: NativeField,
  command: 'insertText' | 'delete' | 'forwardDelete',
  text?: string,
): void {
  if (!supportsNativeFieldSelection(field)) return
  field.focus()
  if (command === 'insertText') {
    document.execCommand('insertText', false, text ?? '')
  } else {
    document.execCommand(command)
  }
}

export function setFieldSelection(
  field: NativeField,
  start: number,
  end = start,
  direction: 'forward' | 'backward' | 'none' = 'forward',
): void {
  if (supportsNativeFieldSelection(field)) field.setSelectionRange(start, end, direction)
}

export function previousGrapheme(value: string, offset: number): number {
  if (offset <= 0) return 0
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value.slice(0, offset)),
  ]
  return segments.at(-1)?.index ?? 0
}

export function nextGrapheme(value: string, offset: number): number {
  if (offset >= value.length) return value.length
  const segment = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    .segment(value.slice(offset))
    .containing(0)
  return offset + (segment?.segment.length ?? 1)
}
