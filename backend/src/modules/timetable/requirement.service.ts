import {
  DEFAULT_MAX_PER_DAY,
  SUITABILITY_TAG_CODES,
  type ApplyGradeData,
  type CopySectionData,
  type EffectiveRequirementDTO,
  type ListRequirementsQuery,
  type RequirementCopyResultDTO,
  type RequirementItemData,
  type RequirementListDTO,
  type RequirementSaveResultDTO,
  type RequirementSource,
  type RequirementValuesDTO,
  type SaveRequirementsData,
  type SuitabilityTagCode,
  type WeekTotalDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { recordTimetableAudit } from './audit';
import { loadBellContext, weekSlots, type BellContext } from './bell.resolve';
import { loadPlanFacts, requirePlanClass, requirePlanSection, subjectCodeOf, subjectNameOf, type PlanFacts } from './facts';
import { readablePlan, writablePlan } from './guards';
import { Requirement, TeachingGroup, type RequirementDoc, type TeachingGroupDoc, type TimetablePlanDoc } from './models';

/** TT-09, TT-10 — Subject Needs: how many periods a week each subject needs. Stored once per class; a section only stores its exceptions. */

const DEFAULTS: RequirementValuesDTO = { periodsPerWeek: 0, minPerWeek: null, maxPerWeek: null, maxPerDay: DEFAULT_MAX_PER_DAY, doubleMode: 'NONE', doublesPerWeek: 0, preferredBand: 'ANY', neededSuitability: [], priority: 0 };
const TAGS = new Set<string>(SUITABILITY_TAG_CODES);

export function valuesOf(doc: Pick<RequirementDoc, keyof RequirementValuesDTO>): RequirementValuesDTO {
  return { periodsPerWeek: doc.periodsPerWeek, minPerWeek: doc.minPerWeek, maxPerWeek: doc.maxPerWeek, maxPerDay: doc.maxPerDay, doubleMode: doc.doubleMode, doublesPerWeek: doc.doublesPerWeek, preferredBand: doc.preferredBand, neededSuitability: [...doc.neededSuitability].sort(), priority: doc.priority };
}

const sameValues = (a: RequirementValuesDTO, b: RequirementValuesDTO) => JSON.stringify(a) === JSON.stringify(b);

const invalid = (message: string, field?: string, extra: Record<string, unknown> = {}) => new AppError('REQUIREMENT_INVALID', message, { ...(field ? { fields: { [field]: message } } : {}), ...extra });

/** Merge what the caller sent over what is there (or the defaults), tidy it, and refuse anything that cannot work. */
function merge(base: RequirementValuesDTO, item: Partial<RequirementValuesDTO>, subject: string): RequirementValuesDTO {
  const pick = <K extends keyof RequirementValuesDTO>(key: K): RequirementValuesDTO[K] => (item[key] !== undefined ? (item[key] as RequirementValuesDTO[K]) : base[key]);
  const next: RequirementValuesDTO = {
    periodsPerWeek: pick('periodsPerWeek'),
    minPerWeek: pick('minPerWeek'),
    maxPerWeek: pick('maxPerWeek'),
    maxPerDay: pick('maxPerDay'),
    doubleMode: pick('doubleMode'),
    doublesPerWeek: pick('doublesPerWeek'),
    preferredBand: pick('preferredBand'),
    neededSuitability: [...new Set(pick('neededSuitability'))].sort() as SuitabilityTagCode[],
    priority: pick('priority'),
  };
  const bad = next.neededSuitability.find((t) => !TAGS.has(t));
  if (bad) throw invalid(`${subject}: "${bad}" is not a room kind we know. Choose one from the list.`, 'neededSuitability');
  if (next.minPerWeek !== null && next.minPerWeek > next.periodsPerWeek) throw invalid(`${subject}: the least a week (${next.minPerWeek}) can't be more than the periods a week (${next.periodsPerWeek}).`, 'minPerWeek');
  if (next.maxPerWeek !== null && next.maxPerWeek < next.periodsPerWeek) throw invalid(`${subject}: the most a week (${next.maxPerWeek}) can't be less than the periods a week (${next.periodsPerWeek}).`, 'maxPerWeek');
  if (next.doubleMode === 'NONE') next.doublesPerWeek = 0;
  else if (next.doublesPerWeek === 0) next.doublesPerWeek = 1;
  if (next.doublesPerWeek * 2 > next.periodsPerWeek) throw invalid(`${subject}: ${next.doublesPerWeek} double period${next.doublesPerWeek === 1 ? '' : 's'} need ${next.doublesPerWeek * 2} periods a week, but only ${next.periodsPerWeek} ${next.periodsPerWeek === 1 ? 'is' : 'are'} set.`, 'doublesPerWeek');
  return next;
}

// ───────────────────────────────────────────────────────────── reading

function totalOf(needed: number, available: number | null): WeekTotalDTO {
  if (available === null) return { needed, available: null, ok: true, message: `Total ${needed} period${needed === 1 ? '' : 's'}. Set up Daily Periods to see if they fit the week.` };
  return needed <= available ? { needed, available, ok: true, message: `Total ${needed} of ${available} periods` } : { needed, available, ok: false, message: `Needs ${needed} periods, the week has ${available}` };
}

/** The periods a class's week can hold: its smallest section, because every section must fit. */
function classAvailable(bell: BellContext, facts: PlanFacts, classOfferingId: string): number | null {
  const sections = facts.sections.filter((s) => s.classOfferingId === classOfferingId);
  const values = (sections.length ? sections.map((s) => weekSlots(bell, classOfferingId, s._id)) : [weekSlots(bell, classOfferingId, null)]).filter((v): v is number => v !== null);
  return values.length ? Math.min(...values) : null;
}

export async function listRequirements(ctx: ServiceContext, query: ListRequirementsQuery): Promise<RequirementListDTO> {
  const plan = await readablePlan(ctx, query.planId);
  const facts = await loadPlanFacts(ctx, plan);
  const bell = await loadBellContext(ctx, plan);

  if (query.teachingGroupId) {
    const group = await TeachingGroup.findOne({ _id: query.teachingGroupId, tenantId: ctx.tenantId, planId: plan._id }).lean<TeachingGroupDoc>();
    if (!group || !group.classOfferingId || !group.subjectOfferingId) throw AppError.notFound('Teaching Group not found.');
    const row = await Requirement.findOne({ tenantId: ctx.tenantId, planId: plan._id, scope: 'GROUP', teachingGroupId: group._id, subjectOfferingId: group.subjectOfferingId }).lean<RequirementDoc>();
    const item = toItem(facts, group.subjectOfferingId, row ? 'GROUP' : 'NONE', row ?? undefined, null);
    const pool = group.sectionPool.map((id) => facts.sectionOf.get(id)).filter((s) => s !== undefined);
    const slots = pool.map((s) => weekSlots(bell, s.classOfferingId, s._id)).filter((v): v is number => v !== null);
    return { planId: plan._id, classOfferingId: group.classOfferingId, sectionOfferingId: null, items: [item], total: totalOf(item.effective.periodsPerWeek, slots.length ? Math.min(...slots) : null), sectionsWithOverrides: 0 };
  }

  if (!query.classOfferingId && !query.sectionOfferingId) throw AppError.validation({ classOfferingId: 'Choose a class.' });
  let classOfferingId = query.classOfferingId;
  if (query.sectionOfferingId) {
    const section = await requirePlanSection(ctx, plan, query.sectionOfferingId);
    if (classOfferingId && classOfferingId !== section.classOfferingId) throw AppError.validation({ sectionOfferingId: 'This section is not in that class.' });
    classOfferingId = section.classOfferingId;
  } else await requirePlanClass(ctx, plan, classOfferingId!);

  const rows = await Requirement.find({ tenantId: ctx.tenantId, planId: plan._id, classOfferingId, scope: { $in: ['CLASS', 'SECTION'] } }).lean<RequirementDoc[]>();
  const classRows = new Map(rows.filter((r) => r.scope === 'CLASS').map((r) => [r.subjectOfferingId, r]));
  const sectionRows = new Map(rows.filter((r) => r.scope === 'SECTION' && r.sectionOfferingId === (query.sectionOfferingId ?? '')).map((r) => [r.subjectOfferingId, r]));
  const items = facts.subjectOfferings
    .filter((o) => o.classOfferingId === classOfferingId)
    .map((o) => {
      const own = sectionRows.get(o._id);
      const klass = classRows.get(o._id);
      return toItem(facts, o._id, own ? 'SECTION' : klass ? 'CLASS' : 'NONE', own ?? klass, klass ?? null);
    });
  const needed = items.reduce((n, i) => n + i.effective.periodsPerWeek, 0);
  const available = query.sectionOfferingId ? weekSlots(bell, classOfferingId!, query.sectionOfferingId) : classAvailable(bell, facts, classOfferingId!);
  const sectionsWithOverrides = new Set(rows.filter((r) => r.scope === 'SECTION').map((r) => r.sectionOfferingId)).size;
  return { planId: plan._id, classOfferingId: classOfferingId!, sectionOfferingId: query.sectionOfferingId ?? null, items, total: totalOf(needed, available), sectionsWithOverrides };
}

function toItem(facts: PlanFacts, subjectOfferingId: string, source: RequirementSource, row: RequirementDoc | undefined, classRow: RequirementDoc | null): EffectiveRequirementDTO {
  return {
    subjectOfferingId,
    subjectName: subjectNameOf(facts, subjectOfferingId),
    subjectCode: subjectCodeOf(facts, subjectOfferingId),
    source,
    requirementId: row?._id ?? null,
    version: row?.version ?? null,
    configured: Boolean(row),
    effective: row ? valuesOf(row) : { ...DEFAULTS },
    classDefault: classRow ? valuesOf(classRow) : null,
  };
}

// ───────────────────────────────────────────────────────────── writing

interface Resolved {
  item: RequirementItemData;
  classOfferingId: string;
  sectionOfferingId: string | null;
  teachingGroupId: string | null;
}

async function resolveItem(ctx: ServiceContext, plan: TimetablePlanDoc, facts: PlanFacts, item: RequirementItemData): Promise<Resolved> {
  const offering = facts.offeringOf.get(item.subjectOfferingId);
  if (item.scope === 'GROUP') {
    if (!item.teachingGroupId) throw invalid('Choose the Teaching Group.', 'teachingGroupId');
    const group = await TeachingGroup.findOne({ _id: item.teachingGroupId, tenantId: ctx.tenantId, planId: plan._id, status: 'ACTIVE' }).lean<TeachingGroupDoc>();
    if (!group) throw AppError.notFound('Teaching Group not found.');
    if (!group.classOfferingId || group.subjectOfferingId !== item.subjectOfferingId) throw invalid('A group\'s Subject Needs are for the subject of that group.', 'subjectOfferingId');
    return { item, classOfferingId: group.classOfferingId, sectionOfferingId: null, teachingGroupId: group._id };
  }
  await requirePlanClass(ctx, plan, item.classOfferingId);
  if (!offering || offering.classOfferingId !== item.classOfferingId) throw invalid('This subject is not offered in that class.', 'subjectOfferingId');
  if (item.scope === 'SECTION') {
    if (!item.sectionOfferingId) throw invalid('Choose the section.', 'sectionOfferingId');
    const section = await requirePlanSection(ctx, plan, item.sectionOfferingId);
    if (section.classOfferingId !== item.classOfferingId) throw invalid('This section is not in that class.', 'sectionOfferingId');
    return { item, classOfferingId: item.classOfferingId, sectionOfferingId: section._id, teachingGroupId: null };
  }
  return { item, classOfferingId: item.classOfferingId, sectionOfferingId: null, teachingGroupId: null };
}

async function saveResolved(ctx: ServiceContext, plan: TimetablePlanDoc, facts: PlanFacts, resolved: Resolved[], action: string): Promise<{ saved: number; unchanged: number }> {
  let saved = 0;
  let unchanged = 0;
  await withTransaction(async (db) => {
    saved = 0;
    unchanged = 0;
    for (const r of resolved) {
      const key = { tenantId: ctx.tenantId, planId: plan._id, scope: r.item.scope, classOfferingId: r.classOfferingId, sectionOfferingId: r.sectionOfferingId, teachingGroupId: r.teachingGroupId, subjectOfferingId: r.item.subjectOfferingId };
      const existing = await Requirement.findOne(key).session(db).lean<RequirementDoc>();
      if (existing && r.item.version !== undefined && r.item.version !== existing.version) throw new AppError('VERSION_CONFLICT', undefined, { currentVersion: existing.version, subjectOfferingId: r.item.subjectOfferingId });
      const name = subjectNameOf(facts, r.item.subjectOfferingId);
      const next = merge(existing ? valuesOf(existing) : DEFAULTS, { periodsPerWeek: r.item.periodsPerWeek, minPerWeek: r.item.minPerWeek, maxPerWeek: r.item.maxPerWeek, maxPerDay: r.item.maxPerDay, doubleMode: r.item.doubleMode, doublesPerWeek: r.item.doublesPerWeek, preferredBand: r.item.preferredBand, neededSuitability: r.item.neededSuitability as SuitabilityTagCode[] | undefined, priority: r.item.priority }, name);
      if (existing && sameValues(valuesOf(existing), next)) {
        unchanged += 1;
        continue;
      }
      if (existing) await Requirement.updateOne({ _id: existing._id, tenantId: ctx.tenantId }, { $set: { ...next, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
      else await Requirement.create([{ ...key, schoolId: plan.schoolId, ...next, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
      saved += 1;
    }
    await recordTimetableAudit(ctx, db, { entityType: 'schedule_requirement', entityId: plan._id, action, planId: plan._id, locationId: plan.locationId, metadata: { saved, unchanged, scope: resolved[0]?.item.scope, classOfferingId: resolved[0]?.classOfferingId } });
  });
  return { saved, unchanged };
}

async function totalFor(ctx: ServiceContext, plan: TimetablePlanDoc, classOfferingId: string, sectionOfferingId: string | null): Promise<WeekTotalDTO> {
  return (await listRequirements(ctx, { planId: plan._id, classOfferingId, sectionOfferingId: sectionOfferingId ?? undefined })).total;
}

export async function saveRequirements(ctx: ServiceContext, data: SaveRequirementsData): Promise<RequirementSaveResultDTO> {
  const plan = await writablePlan(ctx, data.planId);
  const facts = await loadPlanFacts(ctx, plan);
  const resolved: Resolved[] = [];
  for (const item of data.items) resolved.push(await resolveItem(ctx, plan, facts, item));
  const result = await saveResolved(ctx, plan, facts, resolved, 'schedule_requirement.saved');
  const first = resolved[0]!;
  return { ...result, total: await totalFor(ctx, plan, first.classOfferingId, first.sectionOfferingId) };
}

/** Writes class rows only, so every section of the class inherits at once. */
export async function applyGrade(ctx: ServiceContext, data: ApplyGradeData): Promise<RequirementSaveResultDTO> {
  const plan = await writablePlan(ctx, data.planId);
  const facts = await loadPlanFacts(ctx, plan);
  const resolved: Resolved[] = [];
  for (const row of data.items) resolved.push(await resolveItem(ctx, plan, facts, { ...row, scope: 'CLASS', classOfferingId: data.classOfferingId }));
  const result = await saveResolved(ctx, plan, facts, resolved, 'schedule_requirement.applied_to_class');
  return { ...result, total: await totalFor(ctx, plan, data.classOfferingId, null) };
}

/** Makes each target section match the source section. A section row is only written where the value differs from the class value. */
export async function copySection(ctx: ServiceContext, data: CopySectionData): Promise<RequirementCopyResultDTO> {
  const plan = await writablePlan(ctx, data.planId);
  const from = await requirePlanSection(ctx, plan, data.fromSectionId);
  const targets: string[] = [];
  for (const id of new Set(data.toSectionIds)) {
    if (id === from._id) continue;
    const target = await requirePlanSection(ctx, plan, id);
    if (target.classOfferingId !== from.classOfferingId) throw invalid('Copying only works between sections of the same class.', 'toSectionIds');
    targets.push(id);
  }
  const facts = await loadPlanFacts(ctx, plan);
  const offerings = facts.subjectOfferings.filter((o) => o.classOfferingId === from.classOfferingId);
  let copied = 0;
  let alreadySame = 0;
  await withTransaction(async (db) => {
    copied = 0;
    alreadySame = 0;
    const rows = await Requirement.find({ tenantId: ctx.tenantId, planId: plan._id, classOfferingId: from.classOfferingId, scope: { $in: ['CLASS', 'SECTION'] } }).session(db).lean<RequirementDoc[]>();
    const classRow = new Map(rows.filter((r) => r.scope === 'CLASS').map((r) => [r.subjectOfferingId, r]));
    const sectionRow = (sectionId: string, subjectId: string) => rows.find((r) => r.scope === 'SECTION' && r.sectionOfferingId === sectionId && r.subjectOfferingId === subjectId);
    for (const target of targets) {
      for (const offering of offerings) {
        const base = classRow.get(offering._id);
        const source = sectionRow(from._id, offering._id) ?? base;
        if (!source) continue;
        const desired = valuesOf(source);
        const own = sectionRow(target, offering._id);
        const wantsOverride = !base || !sameValues(desired, valuesOf(base));
        if (!wantsOverride) {
          if (own) {
            await Requirement.deleteOne({ _id: own._id, tenantId: ctx.tenantId }, { session: db });
            copied += 1;
          } else alreadySame += 1;
        } else if (own && sameValues(valuesOf(own), desired)) alreadySame += 1;
        else if (own) {
          await Requirement.updateOne({ _id: own._id, tenantId: ctx.tenantId }, { $set: { ...desired, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
          copied += 1;
        } else {
          await Requirement.create([{ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId: plan._id, scope: 'SECTION', classOfferingId: from.classOfferingId, sectionOfferingId: target, teachingGroupId: null, subjectOfferingId: offering._id, ...desired, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
          copied += 1;
        }
      }
    }
    await recordTimetableAudit(ctx, db, { entityType: 'schedule_requirement', entityId: plan._id, action: 'schedule_requirement.copied_to_sections', planId: plan._id, locationId: plan.locationId, metadata: { fromSectionId: from._id, targets: targets.length, copied, alreadySame } });
  });
  return { copied, alreadySame, message: `${copied} copied, ${alreadySame} ${alreadySame === 1 ? 'was' : 'were'} already the same.` };
}

/** Removes a section's own values, so it uses the class values again. */
export async function resetSection(ctx: ServiceContext, data: { planId: string; sectionOfferingId: string; subjectOfferingIds?: string[] }): Promise<{ removed: number }> {
  const plan = await writablePlan(ctx, data.planId);
  await requirePlanSection(ctx, plan, data.sectionOfferingId);
  return withTransaction(async (db) => {
    const result = await Requirement.deleteMany({ tenantId: ctx.tenantId, planId: plan._id, scope: 'SECTION', sectionOfferingId: data.sectionOfferingId, ...(data.subjectOfferingIds?.length ? { subjectOfferingId: { $in: data.subjectOfferingIds } } : {}) }, { session: db });
    if (result.deletedCount > 0) await recordTimetableAudit(ctx, db, { entityType: 'schedule_requirement', entityId: plan._id, action: 'schedule_requirement.reset', planId: plan._id, locationId: plan.locationId, metadata: { sectionOfferingId: data.sectionOfferingId, removed: result.deletedCount } });
    return { removed: result.deletedCount };
  });
}

/** The effective rows of a section, for the readiness check and the engine: section row, else class row. */
export async function effectiveBySection(ctx: ServiceContext, plan: TimetablePlanDoc, facts: PlanFacts): Promise<Map<string, Map<string, RequirementValuesDTO>>> {
  const rows = await Requirement.find({ tenantId: ctx.tenantId, planId: plan._id, scope: { $in: ['CLASS', 'SECTION'] } }).lean<RequirementDoc[]>();
  const out = new Map<string, Map<string, RequirementValuesDTO>>();
  for (const section of facts.sections) {
    const map = new Map<string, RequirementValuesDTO>();
    for (const offering of facts.subjectOfferings.filter((o) => o.classOfferingId === section.classOfferingId)) {
      const own = rows.find((r) => r.scope === 'SECTION' && r.sectionOfferingId === section._id && r.subjectOfferingId === offering._id);
      const klass = rows.find((r) => r.scope === 'CLASS' && r.classOfferingId === section.classOfferingId && r.subjectOfferingId === offering._id);
      const row = own ?? klass;
      if (row) map.set(offering._id, valuesOf(row));
    }
    out.set(section._id, map);
  }
  return out;
}
