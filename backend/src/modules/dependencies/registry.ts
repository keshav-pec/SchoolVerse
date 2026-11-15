import type { ClientSession } from 'mongoose';
import type { LocationDependencyDTO } from '@shared';

/**
 * SCH-LOC-11 — location dependency registry (PRD §11 "Archive dependency check").
 *
 * School Setup owns locations but not the records that reference them. Each downstream module
 * (Staff, Students, Academic Structure, Inventory, Finance…) registers a checker here, so this
 * module can answer two questions without importing any of them:
 *
 *   - countActive > 0 → the location still has live operational records: archive is blocked.
 *   - countAny    > 0 → the location has ever been referenced: its code is locked and it can
 *                       no longer be deleted (only archived).
 */
export interface DependencyContext {
  tenantId: string;
  schoolId: string;
  locationId: string;
  session?: ClientSession;
}

export interface LocationDependency {
  /** Stable key, e.g. `staff.assignments`. */
  key: string;
  /** Short UI label, e.g. "Active staff". */
  label: string;
  countActive(ctx: DependencyContext): Promise<number>;
  countAny(ctx: DependencyContext): Promise<number>;
  /** User-facing explanation for a blocked archive, e.g. "12 active staff members are assigned…". */
  message(count: number): string;
}

const registry = new Map<string, LocationDependency>();

export function registerLocationDependency(dependency: LocationDependency) {
  registry.set(dependency.key, dependency);
}

export function unregisterLocationDependency(key: string) {
  registry.delete(key);
}

export function listLocationDependencies(): LocationDependency[] {
  return [...registry.values()];
}

/** Every dependency with live records (empty array → archive allowed). */
export async function findActiveDependencies(ctx: DependencyContext): Promise<LocationDependencyDTO[]> {
  const results = await Promise.all(
    listLocationDependencies().map(async (dep) => ({ dep, count: await dep.countActive(ctx) })),
  );
  return results
    .filter(({ count }) => count > 0)
    .map(({ dep, count }) => ({ key: dep.key, label: dep.label, count, message: dep.message(count) }));
}

/** True once any downstream record has referenced the location (code lock + no hard delete). */
export async function isLocationReferenced(ctx: DependencyContext): Promise<boolean> {
  for (const dep of listLocationDependencies()) {
    if ((await dep.countAny(ctx)) > 0) return true;
  }
  return false;
}
