import type { ClientSession } from 'mongoose';

/**
 * Academic dependency registry — the same idea as the location registry (modules/dependencies).
 *
 * Faculty, Student, Timetable… modules register a checker that says "this section / subject offering /
 * class offering is in use". On an ACTIVE session, structural changes (deactivating or removing
 * structure) are blocked while any checker reports a count (`ACADEMIC_HAS_DEPENDENCIES`).
 */
export const ACADEMIC_ENTITY_TYPES = [
  'class_offering',
  'section_offering',
  'subject_offering',
  'academic_term',
  'session_location',
  'choice_group',
  'constraint',
  'programme',
] as const;
export type AcademicEntityType = (typeof ACADEMIC_ENTITY_TYPES)[number];

export interface AcademicDependencyContext {
  tenantId: string;
  academicSessionId: string;
  entityType: AcademicEntityType;
  /** The offering / term id, or the location id for `session_location`. */
  entityId: string;
  session?: ClientSession;
}

export interface AcademicDependency {
  /** Stable key, e.g. `faculty.assignments`. */
  key: string;
  label: string;
  /** Which entity types this checker knows about; others are skipped. */
  entityTypes: readonly AcademicEntityType[];
  count(ctx: AcademicDependencyContext): Promise<number>;
  message(count: number): string;
}

export interface AcademicDependencyHit {
  key: string;
  label: string;
  count: number;
  message: string;
}

const registry = new Map<string, AcademicDependency>();

export function registerAcademicDependency(dependency: AcademicDependency) {
  registry.set(dependency.key, dependency);
}

export function unregisterAcademicDependency(key: string) {
  registry.delete(key);
}

export async function findAcademicDependencies(ctx: AcademicDependencyContext): Promise<AcademicDependencyHit[]> {
  const applicable = [...registry.values()].filter((d) => d.entityTypes.includes(ctx.entityType));
  const counted = await Promise.all(applicable.map(async (dep) => ({ dep, count: await dep.count(ctx) })));
  return counted
    .filter(({ count }) => count > 0)
    .map(({ dep, count }) => ({ key: dep.key, label: dep.label, count, message: dep.message(count) }));
}
