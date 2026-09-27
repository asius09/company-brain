import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The single class-merging helper the whole UI layer goes through.
 *
 * `clsx` handles conditionals (`cx('a', isOpen && 'b')`); `twMerge` then
 * resolves Tailwind conflicts so a caller-supplied `className` reliably beats a
 * component's default instead of both landing in the DOM and letting CSS
 * specificity decide.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type { ClassValue };
