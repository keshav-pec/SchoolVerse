import { EMPLOYEE_CATEGORY_LABELS, EMPLOYEE_STATUS_LABELS, type CreateExportData, type ExportPurpose, type ExportResultDTO } from '@shared';
import { toIso } from '../../core/objects';
import { SKIP_TENANT_SCOPE } from '../../db/plugins/tenant-scope';
import { withTransaction } from '../../db/transaction';
import { logger } from '../../core/logger';
import { toCsv } from '../../platform/identity/csv';
import { signFileToken } from '../../platform/identity/crypto';
import { privateStorage } from '../../platform/identity/private-storage';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { auditScopeOf, recordStaffAudit } from './audit';
import { Employee, type EmployeeDoc } from './employee.model';
import { listEmployees } from './employee.service';
import { FILES_PATH } from './document.service';
import { StaffExport, type ExportDoc } from './identity.models';
import type { EmployeeDirectoryDTO } from '@shared';

/**
 * SEC-05 — exports. Each purpose has its own column allowlist; restricted data (date of birth, IDs, bank details) and
 * personal contact are not exportable. The file is stored privately and handed out as a signed link for 15 minutes.
 */

export const EXPORT_LINK_SECONDS = 15 * 60;
const MAX_ROWS = 5000;
const PAGE_SIZE = 100;

const DIRECTORY_COLUMNS = ['Employee code', 'Name', 'Category', 'Department', 'Designation', 'Status', 'Primary location', 'Official email', 'Official phone'] as const;
const EMPLOYMENT_COLUMNS = [...DIRECTORY_COLUMNS, 'Employment type', 'Joining date', 'Confirmation date', 'Reporting manager code', 'Exit date'] as const;

const directoryRow = (e: EmployeeDirectoryDTO) => [
  e.employeeCode,
  e.fullName,
  EMPLOYEE_CATEGORY_LABELS[e.employeeCategory],
  e.department.name,
  e.designation.name,
  EMPLOYEE_STATUS_LABELS[e.status],
  e.primaryLocation?.displayName ?? '',
  e.officialEmail ?? '',
  e.officialPhone ?? '',
];

export async function createExport(ctx: ServiceContext, data: CreateExportData): Promise<ExportResultDTO> {
  // Walk the same filtered list the directory shows, a page at a time.
  const rows: EmployeeDirectoryDTO[] = [];
  for (let page = 1; rows.length < MAX_ROWS; page += 1) {
    const result = await listEmployees(ctx, { ...data.filters, page, pageSize: PAGE_SIZE });
    rows.push(...result.items);
    if (rows.length >= result.total || result.items.length === 0) break;
  }

  let header: readonly string[] = DIRECTORY_COLUMNS;
  let cells: unknown[][] = rows.map(directoryRow);
  if (data.purpose === 'EMPLOYMENT') {
    const employees = await Employee.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.employeeId) } }).lean<EmployeeDoc[]>();
    const byId = new Map(employees.map((e) => [e._id, e]));
    const codeById = new Map(employees.map((e) => [e._id, e.employeeCode]));
    header = EMPLOYMENT_COLUMNS;
    cells = rows.map((r) => {
      const e = byId.get(r.employeeId)!;
      return [...directoryRow(r), e.employmentType ?? '', e.joiningDate, e.confirmationDate ?? '', e.reportingManagerId ? codeById.get(e.reportingManagerId) ?? '' : '', e.exitDate ?? ''];
    });
  }

  // A byte-order mark makes Excel open the file as UTF-8.
  const csv = `\uFEFF${toCsv(header, cells)}`;
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `staff-${data.purpose.toLowerCase()}-${date}.csv`;
  const objectKey = await privateStorage.put(Buffer.from(csv, 'utf8'), { folder: 'exports' });
  const { token, expiresAt } = signFileToken({ k: objectKey, m: 'text/csv; charset=utf-8', n: fileName, t: ctx.tenantId }, EXPORT_LINK_SECONDS);

  try {
    const exportId = await withTransaction(async (db) => {
      const [doc] = await StaffExport.create([{ tenantId: ctx.tenantId, requestedBy: ctx.userId, purpose: data.purpose, fileName, objectKey, rowCount: rows.length, expiresAt }], { session: db });
      await recordStaffAudit(auditScopeOf(ctx), db, {
        entityType: 'export',
        entityId: doc!._id,
        action: 'export.created',
        employeeId: null,
        metadata: { purpose: data.purpose, filters: data.filters, rowCount: rows.length },
      });
      return doc!._id;
    });
    return { exportId, purpose: data.purpose as ExportPurpose, fileName, rowCount: rows.length, url: `${FILES_PATH}/${token}`, expiresAt: toIso(expiresAt)! };
  } catch (err) {
    await privateStorage.remove(objectKey);
    throw err;
  }
}

/** Removes the file of every export whose link has expired, then its record. Runs hourly (see `jobs.ts`). */
export async function cleanupExpiredExports(now = new Date()): Promise<number> {
  const expired = await StaffExport.find({ expiresAt: { $lte: now } }).setOptions(SKIP_TENANT_SCOPE).lean<ExportDoc[]>();
  for (const doc of expired) {
    try {
      await privateStorage.remove(doc.objectKey);
      await StaffExport.deleteOne({ _id: doc._id, tenantId: doc.tenantId });
    } catch (err) {
      logger.error({ err, exportId: doc._id }, 'could not clean up an expired export');
    }
  }
  return expired.length;
}
