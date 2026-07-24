/** Monochrome inline SVGs for the Holi-native tree skin — no icon-font
 *  dependency (the app ships none). All inherit `currentColor`. */

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}
    >
      <path d="M6 4l4 4-4 4V4z" />
    </svg>
  )
}

export function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5v6.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-8z" />
    </svg>
  )
}

export function MarkdownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2.5 3h11A1.5 1.5 0 0 1 15 4.5v7A1.5 1.5 0 0 1 13.5 13h-11A1.5 1.5 0 0 1 1 11.5v-7A1.5 1.5 0 0 1 2.5 3zm1 3v4h1.4V8.2L6.2 10l1.3-1.8V10h1.4V6H7.5L6.2 7.9 4.9 6H3.5zm7.3 0v2.1H9.6L11.5 11l1.9-2.9h-1.2V6h-1.4z" />
    </svg>
  )
}
