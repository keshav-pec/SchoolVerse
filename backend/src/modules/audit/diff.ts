import type { AuditChangeDTO } from '@shared';

/** Read a dotted path (e.g. `address.city`) from a plain object. */
export function getPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, source);
}

/** Normalise values so Dates, undefined and nested objects compare and store predictably. */
export function normalizeAuditValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeAuditValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = normalizeAuditValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function isEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeAuditValue(a)) === JSON.stringify(normalizeAuditValue(b));
}

/** Mongo `$set` for the fields in `changes` (values read from `next`), stamped with `updatedBy`. */
export function changedValues(next: object, changes: readonly AuditChangeDTO[], updatedBy: string): Record<string, unknown> {
  const values = next as Record<string, unknown>;
  return { updatedBy, ...Object.fromEntries(changes.map((c) => [c.field, values[c.field]])) };
}

/**
 * Field-level diff for the audit trail. Only the listed fields are compared,
 * so secrets and noisy system fields never leak into audit rows.
 */
export function diffFields(before: unknown, after: unknown, fields: readonly string[]): AuditChangeDTO[] {
  const changes: AuditChangeDTO[] = [];
  for (const field of fields) {
    const from = getPath(before, field);
    const to = getPath(after, field);
    if (!isEqual(from, to)) {
      changes.push({ field, from: normalizeAuditValue(from), to: normalizeAuditValue(to) });
    }
  }
  return changes;
}
