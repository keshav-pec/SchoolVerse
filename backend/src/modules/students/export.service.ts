import {
  STUDENT_EXPORT_LINK_SECONDS,
  STUDENT_STATUS_LABELS,
  type CreateStudentExportData,
  type StudentDirectoryDTO,
  type StudentExportResultDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import { logger } from '../../core/logger';
import { toIso } from '../../core/objects';
import { SKIP_TENANT_SCOPE } from '../../db/plugins/tenant-scope';
import { withTransaction } from '../../db/transaction';
import { toCsv } from '../../platform/identity/csv';
import { signFileToken } from '../../platform/identity/crypto';
import { privateStorage } from '../../platform/identity/private-storage';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { SubjectOffering } from '../academic/offering.model';
import { Subject } from '../academic/subject.model';
import { Person, type PersonDoc } from '../staff/person.model';
import { FILES_PATH } from '../staff/document.service';
import { labelsFor } from '../staff/location-assignment.service';
import { todayFor } from '../staff/status';
import { recordStudentAudit } from './audit';
import { StudentExport, type StudentExportDoc } from './records.models';
import { StudentAdmission, StudentGuardianLink, StudentSubjectEnrollment, type StudentAdmissionDoc, type StudentGuardianLinkDoc } from './student.models';
import { listStudents } from './student.service';

/**
 * SPM-37 — student exports. Each purpose has its own column list; date of birth, address, outside IDs, notes and every other
 * restricted field are never exportable, and a cell starting with `= + - @` is escaped so a spreadsheet cannot run it. The file is
 * private, handed out as a signed link for 15 minutes, and the export is audited with its purpose, filters and row count.
 */

const MAX_ROWS = 5000;
const PAGE_SIZE = 100;

const DIRECTORY = ['Admission number', 'Name', 'Class', 'Section', 'Roll number', 'Status'] as const;
const ACADEMIC = [...DIRECTORY, 'Campus', 'Admission date', 'Subjects'] as const;
const GUARDIAN = [...DIRECTORY, 'Primary parent', 'Parent relationship', 'Parent phone'] as const;

const directoryRow = (s: StudentDirectoryDTO) => [s.admissionNumber ?? '', s.fullName, s.classSection?.className ?? '', s.classSection?.sectionCode ?? '', s.rollNumber ?? '', STUDENT_STATUS_LABELS[s.status]];

export async function createStudentExport(ctx: ServiceContext, data: CreateStudentExportData): Promise<StudentExportResultDTO> {
  // The export permission is separate from `student:view`; the list is read with the viewing right for this one purpose.
  const reader: ServiceContext = { ...ctx, permissions: [...ctx.permissions, 'student:view'] };
  const rows: StudentDirectoryDTO[] = [];
  for (let page = 1; ; page += 1) {
    const result = (await listStudents(reader, { ...data.filters, page, pageSize: PAGE_SIZE } as never)) as { items: StudentDirectoryDTO[]; total: number };
    rows.push(...result.items);
    if (rows.length > MAX_ROWS) throw new AppError('EXPORT_TOO_LARGE');
    if (rows.length >= result.total || result.items.length === 0) break;
  }
  const ids = rows.map((r) => r.studentId);

  let header: readonly string[] = DIRECTORY;
  let cells: unknown[][] = rows.map(directoryRow);

  if (data.purpose === 'ACADEMIC') {
    const today = await todayFor(ctx);
    const [admissions, subjectRows] = await Promise.all([
      StudentAdmission.find({ tenantId: ctx.tenantId, studentId: { $in: ids }, isCurrent: true }).select('studentId admissionDate').lean<Pick<StudentAdmissionDoc, 'studentId' | 'admissionDate'>[]>(),
      StudentSubjectEnrollment.find({ tenantId: ctx.tenantId, studentId: { $in: ids }, cancelledAt: null, effectiveFrom: { $lte: today }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] }).select('studentId subjectOfferingId').lean<{ studentId: string; subjectOfferingId: string }[]>(),
    ]);
    const offerings = await SubjectOffering.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(subjectRows.map((r) => r.subjectOfferingId))] } }).select('subjectId').lean<{ _id: string; subjectId: string }[]>();
    const subjects = await Subject.find({ tenantId: ctx.tenantId, _id: { $in: offerings.map((o) => o.subjectId) } }).select('name').lean<{ _id: string; name: string }[]>();
    const nameOfOffering = new Map(offerings.map((o) => [o._id, subjects.find((s) => s._id === o.subjectId)?.name ?? '']));
    const dateOf = new Map(admissions.map((a) => [a.studentId, a.admissionDate]));
    const subjectsOf = new Map<string, string[]>();
    for (const r of subjectRows) subjectsOf.set(r.studentId, [...(subjectsOf.get(r.studentId) ?? []), nameOfOffering.get(r.subjectOfferingId) ?? '']);
    header = ACADEMIC;
    // Campus shows its name, not its id.
    const campus = await labelsFor(ctx.tenantId, rows.map((r) => r.locationId).filter((id): id is string => Boolean(id)));
    cells = rows.map((r) => [...directoryRow(r), (r.locationId && campus.get(r.locationId)?.displayName) || '', dateOf.get(r.studentId) ?? '', (subjectsOf.get(r.studentId) ?? []).filter(Boolean).sort().join('; ')]);
  }

  if (data.purpose === 'GUARDIAN_CONTACTS') {
    const today = await todayFor(ctx);
    const links = await StudentGuardianLink.find({ tenantId: ctx.tenantId, studentId: { $in: ids }, isPrimary: true, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] }).lean<StudentGuardianLinkDoc[]>();
    const people = await Person.find({ tenantId: ctx.tenantId, _id: { $in: links.map((l) => l.guardianPersonId) } }).lean<PersonDoc[]>();
    const linkOf = new Map(links.map((l) => [l.studentId, l]));
    const personOf = new Map(people.map((p) => [p._id, p]));
    header = GUARDIAN;
    cells = rows.map((r) => {
      const link = linkOf.get(r.studentId);
      const parent = link ? personOf.get(link.guardianPersonId) : undefined;
      return [...directoryRow(r), r.primaryGuardianName ?? '', link?.relationshipType ?? '', parent?.primaryPhone ?? ''];
    });
  }

  // A byte-order mark makes Excel open the file as UTF-8.
  const csv = `\uFEFF${toCsv(header, cells)}`;
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `students-${data.purpose.toLowerCase().replace('_', '-')}-${date}.csv`;
  const objectKey = await privateStorage.put(Buffer.from(csv, 'utf8'), { folder: 'exports' });
  const { token, expiresAt } = signFileToken({ k: objectKey, m: 'text/csv; charset=utf-8', n: fileName, t: ctx.tenantId }, STUDENT_EXPORT_LINK_SECONDS);
  try {
    const exportId = await withTransaction(async (db) => {
      const [doc] = await StudentExport.create([{ tenantId: ctx.tenantId, requestedBy: ctx.userId, purpose: data.purpose, fileName, objectKey, rowCount: rows.length, expiresAt }], { session: db });
      await recordStudentAudit(ctx, db, { entityType: 'student_export', entityId: doc!._id, action: 'student_export.created', studentId: null, metadata: { purpose: data.purpose, filters: data.filters, rowCount: rows.length } });
      return doc!._id;
    });
    return { exportId, purpose: data.purpose, fileName, rowCount: rows.length, url: `${FILES_PATH}/${token}`, expiresAt: toIso(expiresAt)! };
  } catch (err) {
    await privateStorage.remove(objectKey);
    throw err;
  }
}

/** Removes the file of every export whose link has expired, then its record. Runs hourly (see `jobs.ts`). */
export async function cleanupExpiredStudentExports(now = new Date()): Promise<number> {
  const expired = await StudentExport.find({ expiresAt: { $lte: now } }).setOptions(SKIP_TENANT_SCOPE).lean<StudentExportDoc[]>();
  for (const doc of expired) {
    try {
      await privateStorage.remove(doc.objectKey);
      await StudentExport.deleteOne({ _id: doc._id, tenantId: doc.tenantId });
    } catch (err) {
      logger.error({ err, exportId: doc._id }, 'could not clean up an expired student export');
    }
  }
  return expired.length;
}
