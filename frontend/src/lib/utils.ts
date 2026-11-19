import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]![0] : '';
  return (first + last).toUpperCase() || '?';
}

export function greetingFor(date = new Date()) {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function firstName(fullName: string) {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

/** Only the fields that differ from `initial`. Edit forms send just these, so a stale form can never undo someone else's edit. */
export function changedFields<T extends object>(form: T, initial: T): Partial<T> {
  return Object.fromEntries((Object.keys(form) as (keyof T)[]).filter((k) => form[k] !== initial[k]).map((k) => [k, form[k]])) as Partial<T>;
}
