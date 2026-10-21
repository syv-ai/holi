/**
 * The colours a folder can take in the file tree (`state/folder-colours.ts`):
 * categorical hues, so each is a named palette utility with its `dark:` pair,
 * never a literal. The glyph takes the hue and a light fill of it; the menu's
 * swatch is the solid hue.
 */
export const FOLDER_COLOURS = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'sky',
  'violet',
  'pink',
] as const
export type FolderColour = (typeof FOLDER_COLOURS)[number]

export const isFolderColour = (v: unknown): v is FolderColour =>
  typeof v === 'string' && (FOLDER_COLOURS as readonly string[]).includes(v)

/** Spelled out in full, so Tailwind finds every class. */
export const FOLDER_GLYPH: Record<FolderColour, string> = {
  red: 'text-red-500 fill-red-500/20 dark:text-red-400 dark:fill-red-400/20',
  orange: 'text-orange-500 fill-orange-500/20 dark:text-orange-400 dark:fill-orange-400/20',
  amber: 'text-amber-500 fill-amber-500/20 dark:text-amber-400 dark:fill-amber-400/20',
  green: 'text-green-600 fill-green-600/20 dark:text-green-400 dark:fill-green-400/20',
  teal: 'text-teal-600 fill-teal-600/20 dark:text-teal-400 dark:fill-teal-400/20',
  sky: 'text-sky-500 fill-sky-500/20 dark:text-sky-400 dark:fill-sky-400/20',
  violet: 'text-violet-500 fill-violet-500/20 dark:text-violet-400 dark:fill-violet-400/20',
  pink: 'text-pink-500 fill-pink-500/20 dark:text-pink-400 dark:fill-pink-400/20',
}

export const FOLDER_SWATCH: Record<FolderColour, string> = {
  red: 'bg-red-500 dark:bg-red-400',
  orange: 'bg-orange-500 dark:bg-orange-400',
  amber: 'bg-amber-500 dark:bg-amber-400',
  green: 'bg-green-600 dark:bg-green-400',
  teal: 'bg-teal-600 dark:bg-teal-400',
  sky: 'bg-sky-500 dark:bg-sky-400',
  violet: 'bg-violet-500 dark:bg-violet-400',
  pink: 'bg-pink-500 dark:bg-pink-400',
}

export const FOLDER_COLOUR_LABEL: Record<FolderColour, string> = {
  red: 'Red',
  orange: 'Orange',
  amber: 'Amber',
  green: 'Green',
  teal: 'Teal',
  sky: 'Sky',
  violet: 'Violet',
  pink: 'Pink',
}
