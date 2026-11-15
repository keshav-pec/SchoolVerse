/** If `err` is a MongoDB duplicate-key error, returns the indexed field names; otherwise `null`. */
export function duplicateKeyFields(err: unknown): string[] | null {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== 11000) return null;
  const e = err as { keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> };
  return Object.keys(e.keyPattern ?? e.keyValue ?? {});
}
