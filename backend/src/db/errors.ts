/** If `err` is a MongoDB duplicate-key error, returns the indexed field names; otherwise `null`. */
export function duplicateKeyFields(err: unknown): string[] | null {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== 11000) return null;
  const e = err as { keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> };
  return Object.keys(e.keyPattern ?? e.keyValue ?? {});
}

/** `.catch()` handler: turns a duplicate key on `field` into the domain error from `toError`; rethrows anything else. */
export const onDuplicate =
  (field: string, toError: () => Error) =>
  (err: unknown): never => {
    if (duplicateKeyFields(err)?.includes(field)) throw toError();
    throw err;
  };
