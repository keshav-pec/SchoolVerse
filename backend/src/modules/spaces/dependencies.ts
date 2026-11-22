import type { ClientSession } from 'mongoose';
import type { DependencyKind, SpaceDependencyDTO } from '@shared';
import { SpaceAvailabilityBlock } from './space.models';

/**
 * SPACE-52 — the room dependency registry. A room that something depends on cannot simply vanish, so every module that stores a
 * `physicalSpaceId` registers here and answers two questions about one room:
 *
 *   find        what is using it NOW (this is what the archive explanation lists)
 *   hasHistory  has anything EVER used it (this guards a move and a hard delete)
 *
 * Home Classroom assignments register in Part 3. Timetable, Exams, Attendance, Assets, Maintenance, Visitor and Events add themselves
 * when they are built (`FUTURE_SPACE_REGISTRANTS`). Nobody else keeps a room list.
 */
export interface SpaceDependencyQuery {
  tenantId: string;
  physicalSpaceId: string;
  session?: ClientSession;
}

export interface SpaceDependencyRegistrant {
  key: string;
  kind: DependencyKind;
  find(query: SpaceDependencyQuery): Promise<SpaceDependencyDTO[]>;
  hasHistory(query: SpaceDependencyQuery): Promise<boolean>;
  /** A type change can make an assignment invalid (a classroom that becomes a lab). Returns plain-words warnings. */
  checkConversion?(query: SpaceDependencyQuery & { homeClassroomEligibleAfter: boolean }): Promise<string[]>;
}

const registry = new Map<string, SpaceDependencyRegistrant>();

export function registerSpaceDependency(registrant: SpaceDependencyRegistrant) {
  registry.set(registrant.key, registrant);
}

export function unregisterSpaceDependency(key: string) {
  registry.delete(key);
}

export async function findSpaceDependencies(query: SpaceDependencyQuery): Promise<SpaceDependencyDTO[]> {
  const found = await Promise.all([...registry.values()].map((r) => r.find(query)));
  return found.flat();
}

export async function spaceHasHistory(query: SpaceDependencyQuery): Promise<boolean> {
  for (const r of registry.values()) if (await r.hasHistory(query)) return true;
  return false;
}

/** The recheck lines for a type conversion: what each module will look at again. */
export async function conversionWarnings(query: SpaceDependencyQuery & { homeClassroomEligibleAfter: boolean }): Promise<string[]> {
  const lines = await Promise.all([...registry.values()].map((r) => r.checkConversion?.(query) ?? []));
  return lines.flat();
}

let builtIn = false;
/** Availability blocks are history: a room that was ever closed for dates keeps its record. They never stop an archive. */
export function registerBuiltInSpaceDependencies() {
  if (builtIn) return;
  builtIn = true;
  registerSpaceDependency({
    key: 'spaces.availability_blocks',
    kind: 'AVAILABILITY_BLOCK',
    async find() {
      return [];
    },
    async hasHistory({ tenantId, physicalSpaceId, session }) {
      return Boolean(await SpaceAvailabilityBlock.exists({ tenantId, physicalSpaceId }).session(session ?? null));
    },
  });
}
