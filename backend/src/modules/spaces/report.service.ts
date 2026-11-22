import { randomUUID } from 'node:crypto';
import { SPACE_REPORT_TITLES, SPACE_STATUS_LABELS, type SpaceReportDTO, type SpaceReportQuery, type SpaceReportType } from '@shared';
import { withTransaction } from '../../db/transaction';
import { toCsv } from '../../platform/identity/csv';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { todayFor } from '../staff/status';
import { recordSpaceAudit } from './audit';
import { currentSession, spaceAttention } from './attention.service';
import { toHomeClassroomDTOs } from './home-classroom.mappers';
import { assertLocationAccess, spaceScope } from './guards';
import { isMissingCapacity } from './resolve';
import { loadLocationRoomFacts, loadRoomFacts, naturalCompare, type RoomFacts } from './rooms';
import { loadSectionFacts } from './sections';
import { PhysicalSpace, SectionSpaceAssignment, SpaceAvailabilityBlock, type PhysicalSpaceDoc, type SectionSpaceAssignmentDoc, type SpaceAvailabilityBlockDoc } from './space.models';

/**
 * SPACE-79 — eight reports, as plain tables (JSON for the screen, CSV to download). Needs `space:export`, and every read is audited with
 * its filters and row count. A report never shows a section's students: only counts.
 */

type Cell = string | number | null;
type Row = Record<string, Cell>;
type Built = { columns: { key: string; label: string }[]; rows: Row[]; summary?: string | null };

const col = (key: string, label: string) => ({ key, label });
const yes = (v: boolean) => (v ? 'Yes' : 'No');

async function roomsFor(ctx: ServiceContext, query: SpaceReportQuery, today: string): Promise<RoomFacts[]> {
  const scope = await spaceScope(ctx);
  let ids: string[];
  if (query.locationId) {
    await assertLocationAccess(ctx, query.locationId);
    ids = [query.locationId];
  } else ids = ((await PhysicalSpace.distinct('locationId', { tenantId: ctx.tenantId })) as string[]).filter((id) => scope.all || scope.locationIds.includes(id));
  const out: RoomFacts[] = [];
  for (const id of ids) out.push(...(await loadLocationRoomFacts(ctx, id, today)));
  return out.sort((a, b) => naturalCompare(a.path, b.path));
}

const roomColumns = [col('code', 'Room code'), col('name', 'Room name'), col('building', 'Building'), col('floor', 'Floor'), col('type', 'Type'), col('physical', 'Physical capacity'), col('seats', 'Seats for classes'), col('status', 'Status')];
const roomRow = (r: RoomFacts): Row => ({ code: r.space.spaceCode, name: r.space.spaceName, building: r.building?.buildingName ?? '', floor: r.floor?.floorName ?? '', type: r.type.name, physical: r.space.physicalCapacity ?? null, seats: r.resolved.academicCapacity.value, status: r.effective.available ? SPACE_STATUS_LABELS[r.space.operationalStatus] : `${SPACE_STATUS_LABELS[r.space.operationalStatus]} (${r.effective.reason})` });

async function build(ctx: ServiceContext, type: SpaceReportType, query: SpaceReportQuery): Promise<Built> {
  const today = await todayFor(ctx);
  switch (type) {
    case 'space-inventory': {
      const rooms = (await roomsFor(ctx, query, today)).filter((r) => r.space.operationalStatus !== 'ARCHIVED');
      return { columns: [...roomColumns, col('schedulable', 'Can be scheduled'), col('home', 'Can be a Home Classroom')], rows: rooms.map((r) => ({ ...roomRow(r), schedulable: yes(r.resolved.schedulable.value), home: yes(r.resolved.homeClassroomEligible.value) })) };
    }
    case 'schedulable-spaces': {
      const rooms = (await roomsFor(ctx, query, today)).filter((r) => r.space.operationalStatus === 'ACTIVE' && r.effective.available && r.resolved.schedulable.value);
      return { columns: roomColumns, rows: rooms.map(roomRow) };
    }
    case 'archived-spaces': {
      const rooms = (await roomsFor(ctx, query, today)).filter((r) => r.space.operationalStatus === 'ARCHIVED' || (r.space.archiveAfterDate && r.space.archiveAfterDate <= today));
      const archived = await PhysicalSpace.find({ tenantId: ctx.tenantId, operationalStatus: 'ARCHIVED', ...(query.locationId ? { locationId: query.locationId } : {}) }).lean<PhysicalSpaceDoc[]>();
      const have = new Set(rooms.map((r) => r.space._id));
      // `loadLocationRoomFacts` leaves archived rooms out, so they are read directly.
      const extra = [...(await loadRoomFacts(ctx, archived.filter((a) => !have.has(a._id)).map((a) => a._id), today)).values()];
      const all = [...rooms, ...extra];
      return { columns: [...roomColumns, col('archivedOn', 'Archived on')], rows: all.map((r) => ({ ...roomRow(r), archivedOn: r.space.archivedAt ? r.space.archivedAt.toISOString().slice(0, 10) : (r.space.archiveAfterDate ?? null) })) };
    }
    case 'temporarily-unavailable': {
      const rooms = await roomsFor(ctx, query, today);
      const byId = new Map(rooms.map((r) => [r.space._id, r]));
      const rows: Row[] = [];
      for (const r of rooms) if (['TEMPORARILY_UNAVAILABLE', 'RESTRICTED', 'INACTIVE'].includes(r.space.operationalStatus) || !r.effective.available) rows.push({ code: r.space.spaceCode, name: r.space.spaceName, why: r.effective.reason ?? SPACE_STATUS_LABELS[r.space.operationalStatus], from: null, to: null });
      const blocks = await SpaceAvailabilityBlock.find({ tenantId: ctx.tenantId, physicalSpaceId: { $in: [...byId.keys()] }, status: 'ACTIVE', endDatetime: { $gte: new Date() } }).sort({ startDatetime: 1 }).lean<SpaceAvailabilityBlockDoc[]>();
      for (const b of blocks) {
        const r = byId.get(b.physicalSpaceId)!;
        rows.push({ code: r.space.spaceCode, name: r.space.spaceName, why: b.reason ?? (b.blockType === 'RESTRICTED' ? 'Restricted' : 'Unavailable'), from: b.startDatetime.toISOString().slice(0, 10), to: b.endDatetime.toISOString().slice(0, 10) });
      }
      return { columns: [col('code', 'Room code'), col('name', 'Room name'), col('why', 'Why'), col('from', 'From'), col('to', 'To')], rows };
    }
    case 'setup-completeness': {
      const rooms = (await roomsFor(ctx, query, today)).filter((r) => r.space.operationalStatus !== 'ARCHIVED');
      const rows: Row[] = [];
      for (const r of rooms) {
        const missing: string[] = [];
        if (isMissingCapacity(r.type, r.resolved)) missing.push('Seats for classes');
        if (!r.type.isOutdoor && r.space.physicalCapacity === null) missing.push('Physical capacity');
        if (r.space.operationalStatus === 'DRAFT') missing.push('Room is still a draft');
        if (missing.length > 0) rows.push({ code: r.space.spaceCode, name: r.space.spaceName, path: r.path, missing: missing.join(', ') });
      }
      const done = rooms.length - rows.length;
      return { columns: [col('code', 'Room code'), col('name', 'Room name'), col('path', 'Where'), col('missing', 'Still missing')], rows, summary: rooms.length === 0 ? 'There are no rooms yet.' : `${done} of ${rooms.length} rooms are complete (${Math.round((done / rooms.length) * 100)}%).${rows.length ? ' The list shows what each of the others still needs.' : ''}` };
    }
    case 'classroom-allocation': {
      const session = await currentSession(ctx, query.sessionId);
      if (!session) return { columns: [], rows: [], summary: 'There is no active academic session yet.' };
      const scope = await spaceScope(ctx);
      if (query.locationId) await assertLocationAccess(ctx, query.locationId);
      const docs = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, academicSessionId: session._id, ...(query.locationId ? { locationId: query.locationId } : scope.all ? {} : { locationId: { $in: scope.locationIds } }), ...(query.includeCancelled ? {} : { status: { $ne: 'CANCELLED' } }) }).lean<SectionSpaceAssignmentDoc[]>();
      const dtos = await toHomeClassroomDTOs(ctx, docs, today);
      dtos.sort((a, b) => naturalCompare(a.section.label, b.section.label) || a.effectiveFrom.localeCompare(b.effectiveFrom));
      return {
        columns: [col('section', 'Section'), col('students', 'Students'), col('room', 'Room'), col('seats', 'Seats for classes'), col('from', 'From'), col('to', 'To'), col('phase', 'Status'), col('source', 'How it was chosen'), col('shift', 'Shift')],
        rows: dtos.map((d) => ({ section: d.section.label, students: d.section.strength, room: d.room.spaceName, seats: d.room.academicCapacity, from: d.effectiveFrom, to: d.effectiveTo ?? 'End of session', phase: d.phase.charAt(0) + d.phase.slice(1).toLowerCase(), source: d.source.replace(/_/g, ' ').toLowerCase(), shift: d.shiftId ?? '' })),
        summary: `${session.name}.`,
      };
    }
    case 'sections-without-home-classroom': {
      const a = await spaceAttention(ctx, { locationId: query.locationId, sessionId: query.sessionId });
      const rows = a.groups.find((g) => g.group === 'CLASSROOM_ALLOCATION')!.rows;
      const facts = await loadSectionFacts(ctx, rows.map((r) => r.sectionOfferingId!).filter(Boolean), today);
      return { columns: [col('section', 'Section'), col('why', 'What is wrong'), col('suggested', 'Suggested room')], rows: rows.map((r) => ({ section: facts.get(r.sectionOfferingId!)?.label ?? '', why: r.detail, suggested: r.suggestedRoom?.spaceName ?? '' })), summary: a.academicSessionId ? null : 'There is no active academic session yet.' };
    }
    case 'capacity-mismatch': {
      const a = await spaceAttention(ctx, { locationId: query.locationId, sessionId: query.sessionId });
      const rows = a.groups.find((g) => g.group === 'CAPACITY')!.rows;
      return { columns: [col('section', 'Section'), col('detail', 'What is wrong'), col('suggested', 'A larger room')], rows: rows.map((r) => ({ section: r.title.replace(' is bigger than its room', ''), detail: r.detail, suggested: r.suggestedRoom ? `${r.suggestedRoom.spaceName} (${r.suggestedRoom.academicCapacity ?? '?'} seats)` : '' })), summary: a.academicSessionId ? null : 'There is no active academic session yet.' };
    }
  }
}

export async function spaceReport(ctx: ServiceContext, type: SpaceReportType, query: SpaceReportQuery): Promise<{ report: SpaceReportDTO; csv: string | null; fileName: string }> {
  const built = await build(ctx, type, query);
  const report: SpaceReportDTO = { type, title: SPACE_REPORT_TITLES[type], generatedAt: new Date().toISOString(), columns: built.columns, rows: built.rows, summary: built.summary ?? null };
  await withTransaction((db) => recordSpaceAudit(ctx, db, { entityType: 'export', entityId: randomUUID(), action: 'space_report.exported', metadata: { type, format: query.format, rowCount: report.rows.length, filters: { locationId: query.locationId ?? null, sessionId: query.sessionId ?? null } } }));
  const csv = query.format === 'csv' ? `\uFEFF${toCsv(built.columns.map((c) => c.label), built.rows.map((r) => built.columns.map((c) => r[c.key] ?? '')))}` : null;
  return { report, csv, fileName: `${type}-${new Date().toISOString().slice(0, 10)}.csv` };
}

