import type {
  ApplyFixData,
  AvailabilityQuery,
  ChoiceDTO,
  ExplainQuery,
  ExplainUnplacedDTO,
  FixRecommendationsData,
  FixRecommendationsDTO,
  FixSuggestionDTO,
  PublicOp,
  RecommendPickData,
  RecommendSlotsData,
  RoomPickDTO,
  SlotMapData,
  SlotMapDTO,
  SlotOptionDTO,
  SlotRecommendationDTO,
  SlotStatus,
  WriteResultDTO,
} from '@shared';
import { opSchema } from '@shared';
import { z } from 'zod';
import { AppError } from '../../../core/errors';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { explainUnplaced, moveOutcomes } from '../engine/alternatives';
import { bestRoom, makeEntry, roomOptions } from '../engine/build';
import { allowedTeachers, checkChange, neededTags } from '../engine/check';
import { lessonsFor, needItems } from '../engine/coverage';
import { namerOf } from '../engine/messages';
import { rankSlots, targetOf, validOnly, type Candidate, type Target } from '../engine/rank';
import { loadSnapshot } from '../engine/snapshot';
import type { EntryRec, Issue, Op, Snapshot } from '../engine/types';
import { assertUnlocked, freshEntry, toOps, validateRefs } from './ops';
import { runChange } from './pipeline';
import { readableVersion } from './version.service';

/** TT-28, TT-UX-13, 14, 22 — which slots, rooms and teachers work, the best pick with its reasons, and ready-made fixes for a warning. */

async function snapshotOf(ctx: ServiceContext, versionId: string): Promise<Snapshot> {
  const { version, plan } = await readableVersion(ctx, versionId);
  return loadSnapshot(ctx, plan, version);
}

function requireTarget(snap: Snapshot, input: { sectionId?: string; groupId?: string; subjectOfferingId?: string }): Target {
  const target = targetOf(snap, input);
  if (!target) throw AppError.validation({ sectionId: 'Choose a section and a subject, or a Teaching Group.' });
  if (target.kind === 'SECTION' && !snap.facts.sectionOf.has(target.sectionIds[0]!)) throw AppError.notFound('Section not found.');
  return target;
}

const statusOf = (c: { blockers: Issue[]; warnings: Issue[] }): SlotStatus => (c.blockers.length > 0 ? 'BLOCKED' : c.warnings.length > 0 ? 'WARNING' : 'OK');
const reasonOf = (c: { blockers: Issue[]; warnings: Issue[] }): string | null => c.blockers[0]?.message ?? c.warnings[0]?.message ?? null;

// ───────────────────────────────────────────────────────────── slot map

/** The whole week as OK / Warning / Blocked, asked of the same checker the save uses, so an OK slot saves and a blocked one refuses. */
export async function slotMap(ctx: ServiceContext, data: SlotMapData): Promise<SlotMapDTO> {
  const { version, plan } = await readableVersion(ctx, data.versionId);
  const snap = await loadSnapshot(ctx, plan, version);
  const days = new Map<string, SlotMapDTO['days'][number]>();
  const put = (weekday: SlotMapDTO['days'][number]['weekday'], slot: SlotMapDTO['days'][number]['slots'][number]) => {
    const day = days.get(weekday) ?? { weekday, slots: [] };
    day.slots.push(slot);
    days.set(weekday, day);
  };
  if (data.entryId) {
    const rec = freshEntry(snap, data.entryId);
    for (const m of moveOutcomes(snap, rec)) {
      const here = m.slot.weekday === rec.weekday && m.slot.period.id === rec.periodId;
      put(m.slot.weekday, { periodId: m.slot.period.id, periodCode: m.slot.period.code, status: here ? 'OK' : statusOf(m.outcome), reason: here ? 'Where it is now' : reasonOf(m.outcome) });
    }
  } else {
    const target = requireTarget(snap, data);
    for (const c of rankSlots(snap, target)) put(c.weekday, { periodId: c.period.id, periodCode: c.period.code, status: statusOf(c), reason: reasonOf(c) });
  }
  const order = snap.plan.operatingDays;
  return { versionId: data.versionId, rev: version.rev, days: [...days.values()].sort((a, b) => order.indexOf(a.weekday) - order.indexOf(b.weekday)).map((d) => ({ ...d, slots: d.slots.sort((a, b) => (snap.periods.get(a.periodId)?.startMin ?? 0) - (snap.periods.get(b.periodId)?.startMin ?? 0)) })) };
}

// ───────────────────────────────────────────────────────────── recommend slots

export function slotOption(snap: Snapshot, c: Candidate): SlotOptionDTO {
  const n = namerOf(snap);
  const first = c.entries[0]!;
  return {
    weekday: c.weekday,
    periodId: c.period.id,
    periodCode: c.period.code,
    label: n.when(c.weekday, c.period.id),
    why: c.why,
    warnings: c.warnings.map((w) => w.message),
    teacherNames: first.teachers.map((t) => n.teacher(t.employeeId)),
    roomName: first.spaceId ? n.room(first.spaceId) : null,
    score: Math.round(c.score * 10) / 10,
    secondPeriodId: c.second?.id ?? null,
  };
}

export async function recommendSlots(ctx: ServiceContext, data: RecommendSlotsData): Promise<SlotRecommendationDTO> {
  const snap = await snapshotOf(ctx, data.versionId);
  const target = requireTarget(snap, data);
  const options = validOnly(rankSlots(snap, target, { double: data.double })).slice(0, data.count).map((c) => slotOption(snap, c));
  if (options.length > 0) return { recommended: options[0]!, alternatives: options.slice(1), message: null };
  const item = needItems(snap).find((i) => (target.groupId ? i.groupId === target.groupId : i.sectionId === target.sectionIds[0] && i.subjectOfferingId === target.subjectOfferingId));
  return { recommended: null, alternatives: [], message: explainUnplaced(snap, target, item?.needed ?? 0, item ? lessonsFor(snap, item).length : 0).message };
}

// ───────────────────────────────────────────────────────────── teachers and rooms for a slot

/** A lesson in the given slot, as someone is about to ask for it. The lesson being edited is taken out of the way first. */
function probe(snap: Snapshot, data: Pick<AvailabilityQuery, 'weekday' | 'periodId' | 'sectionId' | 'groupId' | 'subjectOfferingId' | 'excludeEntryId'>, teacherIds?: string[], spaceId?: string | null): { entry: EntryRec; ops: Op[] } {
  if (!snap.periods.has(data.periodId)) throw AppError.notFound('Period not found.');
  if (!data.sectionId && !data.groupId) throw AppError.validation({ sectionId: 'Choose the section or Teaching Group.' });
  if (data.sectionId && !snap.facts.sectionOf.has(data.sectionId)) throw AppError.notFound('Section not found.');
  const entry = makeEntry(snap, { weekday: data.weekday, periodId: data.periodId, entryType: data.subjectOfferingId || data.groupId ? 'SUBJECT' : 'ACTIVITY', subjectOfferingId: data.subjectOfferingId, groupId: data.groupId, sectionIds: data.sectionId ? [data.sectionId] : [], teacherIds: teacherIds ?? [], spaceId });
  const ops: Op[] = [...(data.excludeEntryId && snap.board.get(data.excludeEntryId) ? [{ type: 'delete' as const, id: data.excludeEntryId }] : []), { type: 'create', entry }];
  return { entry, ops };
}

const TEACHER_RULES = new Set(['TEACHER_BUSY', 'TEACHER_UNAVAILABLE', 'WRONG_CAMPUS', 'TRAVEL_TIME']);
const ROOM_RULES = new Set(['ROOM_BUSY', 'ROOM_UNAVAILABLE', 'ROOM_NOT_SUITABLE']);

export async function availableFaculty(ctx: ServiceContext, q: AvailabilityQuery): Promise<ChoiceDTO[]> {
  const snap = await snapshotOf(ctx, q.versionId);
  const n = namerOf(snap);
  probe(snap, q);
  const allowed = new Set(allowedTeachers(snap, { groupId: q.groupId ?? null, sectionIds: q.sectionId ? [q.sectionId] : [], subjectOfferingId: q.subjectOfferingId ?? null }));
  const out: ChoiceDTO[] = [];
  for (const id of [...snap.campusTeachers]) {
    const { entry, ops } = probe(snap, q, [id], null);
    const outcome = checkChange(snap, ops);
    const bad = outcome.blockers.find((b) => b.entryId === entry.id && TEACHER_RULES.has(b.rule) && b.culprit?.id === id);
    const note = outcome.warnings.find((w) => w.rule === 'TEACHER_NOT_PREFERRED' || w.rule === 'TEACHER_LOAD');
    out.push({ id, name: n.teacher(id), ok: !bad, reason: bad?.message ?? null, recommended: allowed.has(id), detail: note?.message ?? (allowed.has(id) ? 'Assigned in Assign Classes' : null) });
  }
  return out.sort((a, b) => Number(b.ok) - Number(a.ok) || Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name));
}

export async function availableSpaces(ctx: ServiceContext, q: AvailabilityQuery): Promise<ChoiceDTO[]> {
  const snap = await snapshotOf(ctx, q.versionId);
  const base = probe(snap, q, undefined, null);
  const home = q.sectionId ? snap.homeRoom.get(q.sectionId) : undefined;
  /** The Home Classroom when it can be used, else the smallest free room that fits. */
  const pick = home && snap.rooms.get(home)?.usable && !snap.closures.has(home) ? home : bestRoom(snap, base.entry)?.spaceId;
  const out: ChoiceDTO[] = [];
  for (const room of snap.rooms.values()) {
    const { entry, ops } = probe(snap, q, undefined, room.spaceId);
    const outcome = checkChange(snap, ops);
    const bad = outcome.blockers.find((b) => b.entryId === entry.id && ROOM_RULES.has(b.rule) && b.culprit?.id === room.spaceId);
    const small = outcome.warnings.find((w) => w.rule === 'ROOM_TOO_SMALL');
    out.push({ id: room.spaceId, name: room.spaceName, ok: !bad, reason: bad?.message ?? null, recommended: room.spaceId === pick, detail: small?.message ?? (room.spaceId === home ? 'Home Classroom' : null) });
  }
  return out.sort((a, b) => Number(b.ok) - Number(a.ok) || Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name, 'en', { numeric: true }));
}

export async function recommendRoom(ctx: ServiceContext, data: RecommendPickData): Promise<RoomPickDTO> {
  const choices = (await availableSpaces(ctx, data)).filter((c) => c.ok);
  return { recommended: choices.find((c) => c.recommended) ?? choices[0] ?? null, choices: choices.slice(0, 5) };
}

export async function recommendFaculty(ctx: ServiceContext, data: RecommendPickData): Promise<RoomPickDTO> {
  const choices = (await availableFaculty(ctx, data)).filter((c) => c.ok);
  const assigned = choices.filter((c) => c.recommended);
  return { recommended: assigned[0] ?? null, choices: (assigned.length > 0 ? assigned : choices).slice(0, 5) };
}

// ───────────────────────────────────────────────────────────── Fix This For Me

const MOVE_RULES = new Set(['TEACHER_UNAVAILABLE', 'TEACHER_NOT_PREFERRED', 'MAX_PER_DAY', 'TEACHER_LOAD']);
const ROOM_FIX_RULES = new Set(['ROOM_UNAVAILABLE', 'ROOM_TOO_SMALL', 'ROOM_NOT_SUITABLE', 'NOT_HOME_ROOM']);

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const tokenSchema = z.object({ v: z.literal(1), versionId: z.string(), label: z.string(), ops: z.array(opSchema).min(1).max(20) });

const fixToken = (versionId: string, label: string, ops: PublicOp[]) => encode({ v: 1, versionId, label, ops });

/** Moves of one lesson to slots where nothing clashes and the named problem is gone. Best first. */
export function moveSuggestions(snap: Snapshot, rec: EntryRec, rule: FixRecommendationsData['rule'], max = 3): FixSuggestionDTO[] {
  const n = namerOf(snap);
  return moveOutcomes(snap, rec)
    .filter((m) => m.outcome.blockers.length === 0 && !(m.slot.weekday === rec.weekday && m.slot.period.id === rec.periodId) && !m.outcome.issues.some((i) => i.rule === rule && i.entryId === rec.id))
    .sort((a, b) => a.outcome.warnings.length - b.outcome.warnings.length)
    .slice(0, max)
    .map((m) => {
      const label = `Move ${n.when(rec.weekday, rec.periodId)} to ${n.when(m.slot.weekday, m.slot.period.id)}`;
      return { label, why: 'Nothing clashes there and the problem goes away.', safe: true, suggestionToken: fixToken(snap.versionId, label, [{ op: 'move', entryId: rec.id, weekday: m.slot.weekday, periodId: m.slot.period.id }]) };
    });
}

export async function fixRecommendations(ctx: ServiceContext, data: FixRecommendationsData): Promise<FixRecommendationsDTO> {
  const snap = await snapshotOf(ctx, data.versionId);
  const rec = freshEntry(snap, data.entryId);
  const suggestions: FixSuggestionDTO[] = [];
  if (MOVE_RULES.has(data.rule)) suggestions.push(...moveSuggestions(snap, rec, data.rule));
  else if (ROOM_FIX_RULES.has(data.rule)) {
    const home = rec.sectionIds.length === 1 ? snap.homeRoom.get(rec.sectionIds[0]!) : undefined;
    const options = roomOptions(snap, rec, neededTags(snap, rec)).filter((o) => o.ok && o.fits && o.room.spaceId !== rec.spaceId && (data.rule !== 'NOT_HOME_ROOM' || o.room.spaceId === home));
    for (const o of options) {
      if (suggestions.length >= 3) break;
      const outcome = checkChange(snap, [{ type: 'update', id: rec.id, patch: { spaceId: o.room.spaceId } }]);
      if (outcome.blockers.length === 0 && !outcome.issues.some((i) => i.rule === data.rule && i.entryId === rec.id)) {
        const label = `Use ${o.room.spaceName}`;
        suggestions.push({ label, why: 'It is free, open and suits this lesson.', safe: true, suggestionToken: fixToken(data.versionId, label, [{ op: 'update', entryId: rec.id, patch: { physicalSpaceId: o.room.spaceId } }]) });
      }
    }
  }
  return { entryId: data.entryId, rule: data.rule, suggestions, message: suggestions.length === 0 ? 'There is no automatic fix for this. Try moving the lesson yourself.' : null };
}

/** Applies a suggestion. It is checked again, exactly like any other change. */
export async function applyFix(ctx: ServiceContext, data: ApplyFixData): Promise<WriteResultDTO> {
  let parsed: z.output<typeof tokenSchema>;
  try {
    parsed = tokenSchema.parse(JSON.parse(Buffer.from(data.suggestionToken, 'base64url').toString('utf8')));
  } catch {
    throw new AppError('ENTRY_INVALID', 'This suggestion is not valid any more. Ask for new suggestions.');
  }
  if (parsed.versionId !== data.versionId) throw new AppError('ENTRY_INVALID', 'This suggestion is for another timetable.');
  const { result } = await runChange(ctx, data.versionId, {
    kind: 'FIX',
    requestId: data.requestId,
    build: async (snap) => {
      for (const op of parsed.ops) {
        if (op.op === 'update') await validateRefs(ctx, snap, { spaceId: op.patch.physicalSpaceId, teacherIds: op.patch.teacherIds });
        else if (op.op === 'move') await validateRefs(ctx, snap, { periodId: op.periodId });
      }
      const ops = toOps(snap, parsed.ops, 'FIX_SUGGESTION');
      for (const op of ops) if (op.type !== 'create') assertUnlocked(snap, snap.board.get(op.id)!, false, op.type === 'update' ? op.patch : undefined);
      return { items: ops.map((op) => ({ ref: op.type === 'create' ? op.entry.id : op.id, label: parsed.label, ops: [op] })), label: `Applied: ${parsed.label}` };
    },
  });
  return result;
}

// ───────────────────────────────────────────────────────────── why a lesson is unplaced

export async function explainUnplacedFor(ctx: ServiceContext, q: ExplainQuery): Promise<ExplainUnplacedDTO> {
  const snap = await snapshotOf(ctx, q.versionId);
  const target = requireTarget(snap, q);
  const item = needItems(snap).find((i) => (target.groupId ? i.groupId === target.groupId : i.sectionId === target.sectionIds[0] && i.subjectOfferingId === target.subjectOfferingId));
  return explainUnplaced(snap, target, item?.needed ?? target.values?.periodsPerWeek ?? 0, item ? lessonsFor(snap, item).length : lessonsFor(snap, { kind: target.kind, sectionId: target.sectionIds[0] ?? null, groupId: target.groupId, subjectOfferingId: target.subjectOfferingId }).length);
}
