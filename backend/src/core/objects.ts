/** Keep only keys whose value is not `undefined` (PATCH semantics: missing = unchanged). */
export function pickDefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Escape user input before using it inside a RegExp. */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function toIso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}
