import { AUDIT_ACTION_LABELS, DEFAULT_TIMEZONE, STUDENT_STATUS_LABELS, type StudentHistoryDTO, type StudentHistoryEntryDTO, type StudentStatus } from '@shared';
import { todayIn } from '../../core/dates';
import { toIso } from '../../core/objects';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { User } from '../../platform/users/user.model';
import { ClassOffering, SectionOffering, SubjectOffering } from '../academic/offering.model';
import { AcademicSession } from '../academic/session.model';
import { Subject } from '../academic/subject.model';
import { AuditEvent, type AuditEventDoc } from '../audit/audit.model';
import { Person, type PersonDoc } from '../staff/person.model';
import { labelsFor } from '../staff/location-assignment.service';
import { timezonesByTenant } from '../staff/status';
import { fullNameOf } from './directory';
import { loadStudent } from './guards';
import {
  StudentAdmission,
  StudentEnrollment,
  StudentGuardianLink,
  StudentSectionAssignment,
  StudentSubjectEnrollment,
  StudentTransferEvent,
  type StudentAdmissionDoc,
  type StudentEnrollmentDoc,
  type StudentGuardianLinkDoc,
  type StudentSectionAssignmentDoc,
  type StudentSubjectEnrollmentDoc,
  type StudentTransferEventDoc,
} from './student.models';

/**
 * `GET /students/:id/history` — one timeline of everything about a student: admissions, enrollments, section placements,
 * subject changes, guardian links, movements, and the audit rows for changes to the student record itself. Domain rows come
 * straight from the effective-dated tables, so the timeline is the same whatever the audit trail holds.
 */

const ENROLLMENT_VERBS: Record<StudentEnrollmentDoc['enrollmentType'], string> = {
  NEW_ADMISSION: 'Admitted to',
  CONTINUING: 'Enrolled in',
  PROMOTED: 'Promoted to',
  REPEATING: 'Repeating',
  TRANSFER_IN: 'Joined',
  READMISSION: 'Readmitted to',
  MID_SESSION_TRANSFER: 'Moved to',
};

const END_VERBS: Partial<Record<StudentEnrollmentDoc['state'], string>> = { COMPLETED: 'Completed', WITHDRAWN: 'Left', TRANSFERRED: 'Moved away from' };

const list = (names: string[]) => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`);

export async function getStudentHistory(ctx: ServiceContext, studentId: string, limit: number): Promise<StudentHistoryDTO> {
  const tenantId = ctx.tenantId;
  await loadStudent(ctx, studentId);
  const [admissions, enrollments, assignments, subjectRows, links, transfers, audit, zones] = await Promise.all([
    StudentAdmission.find({ tenantId, studentId }).lean<StudentAdmissionDoc[]>(),
    StudentEnrollment.find({ tenantId, studentId }).lean<StudentEnrollmentDoc[]>(),
    StudentSectionAssignment.find({ tenantId, studentId, cancelledAt: null }).lean<StudentSectionAssignmentDoc[]>(),
    StudentSubjectEnrollment.find({ tenantId, studentId, cancelledAt: null }).lean<StudentSubjectEnrollmentDoc[]>(),
    StudentGuardianLink.find({ tenantId, studentId }).lean<StudentGuardianLinkDoc[]>(),
    StudentTransferEvent.find({ tenantId, studentId }).lean<StudentTransferEventDoc[]>(),
    // Rows about the student record itself. Enrollment, section, subject and guardian changes come from their own tables above.
    AuditEvent.find({
      tenantId,
      $or: [{ 'metadata.studentId': studentId }, { 'metadata.studentIds': studentId }],
      action: { $regex: '^(student\\.|admission\\.|guardian\\.updated)' },
    })
      .sort({ occurredAt: -1 })
      .limit(limit)
      .lean<AuditEventDoc[]>(),
    timezonesByTenant([tenantId]),
  ]);
  const zone = zones.get(tenantId) ?? DEFAULT_TIMEZONE;

  const classIds = [...new Set([...enrollments.map((e) => e.classOfferingId), ...admissions.map((a) => a.admissionClassOfferingId)])];
  const sectionIds = [...new Set([...assignments.map((a) => a.sectionId), ...transfers.flatMap((t) => [t.fromSectionId, t.toSectionId]).filter((x): x is string => Boolean(x))])];
  const offeringIds = [...new Set(subjectRows.map((r) => r.subjectOfferingId))];
  const guardianIds = [...new Set(links.map((l) => l.guardianPersonId))];
  const [classes, sections, offerings, sessions, guardians, locations] = await Promise.all([
    ClassOffering.find({ tenantId, _id: { $in: classIds } }).select('displayCode displayName').lean<{ _id: string; displayCode: string; displayName: string }[]>(),
    SectionOffering.find({ tenantId, _id: { $in: sectionIds } }).select('sectionCode classOfferingId').lean<{ _id: string; sectionCode: string; classOfferingId: string }[]>(),
    SubjectOffering.find({ tenantId, _id: { $in: offeringIds } }).select('subjectId').lean<{ _id: string; subjectId: string }[]>(),
    AcademicSession.find({ tenantId, _id: { $in: enrollments.map((e) => e.academicSessionId) } }).select('code').lean<{ _id: string; code: string }[]>(),
    Person.find({ tenantId, _id: { $in: guardianIds } }).lean<PersonDoc[]>(),
    labelsFor(tenantId, enrollments.map((e) => e.locationId)),
  ]);
  const subjects = await Subject.find({ tenantId, _id: { $in: offerings.map((o) => o.subjectId) } }).select('name').lean<{ _id: string; name: string }[]>();

  const classOf = new Map(classes.map((c) => [c._id, c]));
  const sectionOf = new Map(sections.map((s) => [s._id, s]));
  const sessionOf = new Map(sessions.map((s) => [s._id, s.code]));
  const guardianOf = new Map(guardians.map((g) => [g._id, fullNameOf(g)]));
  const subjectNameOf = new Map(offerings.map((o) => [o._id, subjects.find((s) => s._id === o.subjectId)?.name ?? 'Unknown subject']));
  const enrollmentOf = new Map(enrollments.map((e) => [e._id, e]));
  const sectionLabel = (sectionId: string | null | undefined, classOfferingId?: string) => {
    const s = sectionId ? sectionOf.get(sectionId) : undefined;
    const c = classOf.get(classOfferingId ?? s?.classOfferingId ?? '');
    return s ? `${c?.displayCode ?? ''}-${s.sectionCode}`.replace(/^-/, '') : 'no section';
  };

  const actorIds = [...new Set([...enrollments, ...assignments, ...subjectRows, ...links, ...admissions].map((r) => r.createdBy).concat(audit.map((a) => a.actorId ?? null)).filter((id): id is string => Boolean(id)))];
  const actors = actorIds.length ? await User.find({ tenantId, _id: { $in: actorIds } }).select('fullName').lean<{ _id: string; fullName: string }[]>() : [];
  const actorName = (id: string | null | undefined) => (id ? actors.find((a) => a._id === id)?.fullName ?? null : null);

  const entries: StudentHistoryEntryDTO[] = [];
  const push = (entry: Omit<StudentHistoryEntryDTO, 'recordedAt' | 'actorName'> & { recordedAt: Date | string | undefined; actor?: string | null }) =>
    entries.push({ entryId: entry.entryId, kind: entry.kind, occurredOn: entry.occurredOn, recordedAt: toIso(entry.recordedAt) ?? entry.occurredOn, title: entry.title, detail: entry.detail, actorName: actorName(entry.actor) });

  for (const a of admissions) {
    push({ entryId: `admission:${a._id}`, kind: 'ADMISSION', occurredOn: a.admissionDate, recordedAt: a.createdAt, title: `Admission recorded: ${a.admissionNumber}`, detail: a.mode === 'MIGRATION' ? 'Existing student added from old records' : a.mode === 'READMISSION' ? 'Readmission' : null, actor: a.createdBy });
  }

  for (const e of enrollments) {
    if (e.state === 'CANCELLED') continue;
    const klass = classOf.get(e.classOfferingId);
    const where = `${klass?.displayName ?? 'a class'} (${sessionOf.get(e.academicSessionId) ?? '?'}, ${locations.get(e.locationId)?.displayName ?? 'unknown location'})`;
    push({ entryId: `enrollment:${e._id}:start`, kind: 'ENROLLMENT', occurredOn: e.effectiveFrom, recordedAt: e.createdAt, title: `${ENROLLMENT_VERBS[e.enrollmentType]} ${where}`, detail: null, actor: e.createdBy });
    const endVerb = END_VERBS[e.state];
    if (endVerb && e.effectiveTo) {
      push({ entryId: `enrollment:${e._id}:end`, kind: 'ENROLLMENT', occurredOn: e.effectiveTo, recordedAt: e.updatedAt, title: `${endVerb} ${klass?.displayName ?? 'a class'} (${sessionOf.get(e.academicSessionId) ?? '?'})`, detail: e.outcome ? `Outcome: ${e.outcome.replace('_', ' ').toLowerCase()}` : null, actor: e.updatedBy });
    }
  }

  const transferStarts = new Set(transfers.map((t) => `${t.toSectionId}:${t.effectiveDate}`));
  for (const a of assignments) {
    // A placement created by a section change is shown by the movement row instead.
    if (transferStarts.has(`${a.sectionId}:${a.effectiveFrom}`)) continue;
    push({ entryId: `section:${a._id}`, kind: 'SECTION', occurredOn: a.effectiveFrom, recordedAt: a.createdAt, title: `Placed in ${sectionLabel(a.sectionId, a.classOfferingId)}`, detail: a.rollNumber ? `Roll number ${a.rollNumber}` : null, actor: a.createdBy });
  }

  for (const t of transfers) {
    push({ entryId: `transfer:${t._id}`, kind: 'TRANSFER', occurredOn: t.effectiveDate, recordedAt: t.createdAt, title: `Moved from ${sectionLabel(t.fromSectionId)} to ${sectionLabel(t.toSectionId)}`, detail: t.reason, actor: t.actorId });
  }

  // Subjects: one line for the rows added together, one for the rows that ended together.
  const added = new Map<string, StudentSubjectEnrollmentDoc[]>();
  const ended = new Map<string, StudentSubjectEnrollmentDoc[]>();
  for (const r of subjectRows) {
    added.set(`${r.enrollmentId}|${r.effectiveFrom}|${r.source}`, [...(added.get(`${r.enrollmentId}|${r.effectiveFrom}|${r.source}`) ?? []), r]);
    const enrollment = enrollmentOf.get(r.enrollmentId);
    if (r.effectiveTo && !(enrollment && enrollment.state !== 'OPEN' && enrollment.effectiveTo === r.effectiveTo)) {
      ended.set(`${r.enrollmentId}|${r.effectiveTo}`, [...(ended.get(`${r.enrollmentId}|${r.effectiveTo}`) ?? []), r]);
    }
  }
  for (const [key, rows] of added) {
    const names = rows.map((r) => subjectNameOf.get(r.subjectOfferingId) ?? 'Unknown subject');
    const first = rows[0]!;
    push({
      entryId: `subjects:add:${key}`,
      kind: 'SUBJECT',
      occurredOn: first.effectiveFrom,
      recordedAt: first.createdAt,
      title: first.source === 'AUTO_MANDATORY' ? `${rows.length} required subject${rows.length === 1 ? '' : 's'} added` : `${rows.length} subject${rows.length === 1 ? '' : 's'} added`,
      detail: list(names),
      actor: first.createdBy,
    });
  }
  for (const [key, rows] of ended) {
    const first = rows[0]!;
    push({ entryId: `subjects:end:${key}`, kind: 'SUBJECT', occurredOn: first.effectiveTo!, recordedAt: first.updatedAt, title: `${rows.length} subject${rows.length === 1 ? '' : 's'} ended`, detail: list(rows.map((r) => subjectNameOf.get(r.subjectOfferingId) ?? 'Unknown subject')), actor: first.updatedBy });
  }

  for (const l of links) {
    const name = guardianOf.get(l.guardianPersonId) ?? 'A guardian';
    push({ entryId: `guardian:${l._id}:start`, kind: 'GUARDIAN', occurredOn: l.effectiveFrom, recordedAt: l.createdAt, title: `${name} linked as ${l.relationshipType}`, detail: [l.isPrimary ? 'Primary guardian' : null, l.isEmergencyContact ? 'Emergency contact' : null].filter(Boolean).join(', ') || null, actor: l.createdBy });
    const endedOn = l.effectiveTo ?? (l.cancelledAt ? todayIn(zone, new Date(l.cancelledAt)) : null);
    if (endedOn) push({ entryId: `guardian:${l._id}:end`, kind: 'GUARDIAN', occurredOn: endedOn, recordedAt: l.updatedAt, title: `${name} (${l.relationshipType}) link ended`, detail: null, actor: l.updatedBy });
  }

  for (const row of audit) {
    // The admission is already shown from its own table.
    if (row.action === 'admission.created') continue;
    const status = row.action === 'student.status_changed' ? row.changes.find((c) => c.field === 'status') : undefined;
    const fields = row.changes.map((c) => c.field).filter((f) => !['status', 'type', 'value'].includes(f));
    push({
      entryId: `audit:${row._id}`,
      kind: 'STUDENT',
      occurredOn: todayIn(zone, new Date(row.occurredAt)),
      recordedAt: row.occurredAt,
      title: status ? `Status changed to ${STUDENT_STATUS_LABELS[status.to as StudentStatus] ?? String(status.to)}` : AUDIT_ACTION_LABELS[row.action] ?? row.action,
      detail: !status && fields.length > 0 ? `Changed: ${fields.join(', ')}` : (row.metadata as { reason?: string | null } | undefined)?.reason ?? null,
      actor: row.actorId,
    });
  }

  entries.sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.recordedAt.localeCompare(a.recordedAt) || a.entryId.localeCompare(b.entryId));
  return { entries: entries.slice(0, limit) };
}
