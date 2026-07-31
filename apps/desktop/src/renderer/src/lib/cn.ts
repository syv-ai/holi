import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** The one class-merge helper. clsx composes; tailwind-merge lets a caller's
 *  className override a primitive's default deterministically (last wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
