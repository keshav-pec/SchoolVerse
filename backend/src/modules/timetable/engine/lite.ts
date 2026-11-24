import type { ClientSession } from 'mongoose';
import type { Weekday } from '@shared';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { spaceService } from '../../spaces/spaceService';
import { loadBellContext, type BellContext } from '../bell.resolve';
import { employeeNames, loadPlanFacts, type PlanFacts } from '../facts';
import { EntryFaculty, EntrySection, TeachingGroup, TimetableEntry, type EntryFacultyDoc, type EntrySectionDoc, type TeachingGroupDoc, type TimetableEntryDoc, type TimetablePlanDoc } from '../models';
import { toRec } from './entries';
import type { NamerSource } from './messages';
import { buildPeriods } from './snapshot';
import type { EntryRec, GroupRec } from './types';

/**
 * A light read of a plan's published lessons and the names to describe them. Reading a day for people (the effective schedule, Daily
 * Operations, one-day change lists) needs only this. It does not load teachers' assignments, students or rooms' suitability, which only
 * the clash checker needs.
 */
export interface LiteBook extends NamerSource {
  plan: TimetablePlanDoc;
  bell: BellContext;
  /** Lessons per version. */
  recs: Map<string, EntryRec[]>;
  groupDocs: Map<string, TeachingGroupDoc>;
  /** Adds names for teachers that appear only in one-day changes. */
  addTeachers(ids: string[]): Promise<void>;
  addRooms(ids: string[]): Promise<void>;
}

export interface LiteOptions {
  /** Only these lessons. */
  entryIds?: string[];
  /** Only lessons on these weekdays. */
  weekdays?: Weekday[];
}

export async function loadLite(ctx: ServiceContext, plan: TimetablePlanDoc, versionIds: string[], db?: ClientSession, options: LiteOptions = {}): Promise<LiteBook> {
  const where = { tenantId: ctx.tenantId, versionId: { $in: versionIds }, ...(options.weekdays ? { weekday: { $in: options.weekdays } } : {}) };
  const entryWhere = options.entryIds ? { ...where, _id: { $in: options.entryIds } } : where;
  const [facts, bell, entryDocs, sectionDocs, facultyDocs, groupList] = await Promise.all([
    loadPlanFacts(ctx, plan, db) as Promise<PlanFacts>,
    loadBellContext(ctx, plan, db),
    TimetableEntry.find(entryWhere).session(db ?? null).lean<TimetableEntryDoc[]>(),
    EntrySection.find(options.entryIds ? { ...where, entryId: { $in: options.entryIds } } : where).session(db ?? null).lean<EntrySectionDoc[]>(),
    EntryFaculty.find(options.entryIds ? { ...where, entryId: { $in: options.entryIds } } : where).session(db ?? null).lean<EntryFacultyDoc[]>(),
    TeachingGroup.find({ tenantId: ctx.tenantId, planId: plan._id }).session(db ?? null).lean<TeachingGroupDoc[]>(),
  ]);
  const periods = buildPeriods(bell);
  const secOf = new Map<string, EntrySectionDoc[]>();
  for (const s of sectionDocs) secOf.set(s.entryId, [...(secOf.get(s.entryId) ?? []), s]);
  const facOf = new Map<string, EntryFacultyDoc[]>();
  for (const f of facultyDocs) facOf.set(f.entryId, [...(facOf.get(f.entryId) ?? []), f]);
  const recs = new Map<string, EntryRec[]>(versionIds.map((id) => [id, []]));
  for (const doc of entryDocs) {
    const rec = toRec(doc, secOf.get(doc._id) ?? [], facOf.get(doc._id) ?? []);
    rec.templateId = periods.get(rec.periodId)?.templateId ?? '';
    recs.get(doc.versionId)?.push(rec);
  }
  const teacherNames = await employeeNames(ctx, [...facultyDocs.map((f) => f.employeeId), ...groupList.flatMap((g) => g.teacherIds ?? [])], db);
  const strangerRooms = new Map<string, { spaceName: string; archived: boolean }>();
  const addRooms = async (ids: string[]) => {
    const missing = [...new Set(ids)].filter((id) => !strangerRooms.has(id));
    for (const [id, r] of await spaceService.roomCampuses(ctx, missing)) strangerRooms.set(id, { spaceName: r.spaceName, archived: r.archived });
  };
  await addRooms(entryDocs.map((e) => e.physicalSpaceId).filter((id): id is string => Boolean(id)));
  const groups = new Map<string, GroupRec>(
    groupList.map((g) => [g._id, { id: g._id, name: g.name, classOfferingId: g.classOfferingId, subjectOfferingId: g.subjectOfferingId, sectionPool: g.sectionPool, members: new Set<string>(), teacherIds: g.teacherIds ?? [], teacherStatus: 'OK' as const }]),
  );
  return {
    plan,
    bell,
    facts,
    periods,
    teacherNames,
    rooms: new Map(),
    strangerRooms,
    groups,
    groupDocs: new Map(groupList.map((g) => [g._id, g])),
    recs,
    async addTeachers(ids) {
      const missing = ids.filter((id) => !teacherNames.has(id));
      for (const [id, name] of await employeeNames(ctx, missing, db)) teacherNames.set(id, name);
    },
    addRooms,
  };
}
