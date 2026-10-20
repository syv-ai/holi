import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/** tailwind-merge, told about the theme's own sizes: without it `text-nav`
 *  reads as a colour, and a primitive's `text-sm` would survive beside it. */
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['nav'] } },
})

/** The one class-merge helper. clsx composes; tailwind-merge lets a caller's
 *  className override a primitive's default deterministically (last wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
