import {
  ADVANCE_LEDGER_KINDS, DUES_LEDGER_KINDS, EXITED_STUDENT_STATUSES,
  type AgingBucket, type BalanceExplanationDTO, type FamilyDTO, type FeeDocumentDTO, type FeeDocumentListDTO, type FinancePulseDTO, type LedgerEntryDTO, type ListAccountsQuery, type ListDocumentsQuery, type OutstandingDTO, type StatementDTO, type StudentAccountDTO, type StudentAccountListDTO, type UpcomingDTO,
} from '@shared';
import { AppError } from '../../../core/errors';
import { daysBetween } from '../../../core/dates';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { ClassOffering } from '../../academic/offering.model';
import { AcademicSession } from '../../academic/session.model';
import { todayFor } from '../../staff/status';
import { Person } from '../../staff/person.model';
import { listStudentsAdmin } from '../../students/student.service';
import { Student, StudentEnrollment, StudentGuardianLink, type StudentEnrollmentDoc } from '../../students/student.models';
import { simplePdf } from '../../students/tc.service';
import { assertInScope, financeCtx, financeScope, monthKeyOf, scopeFilter, type FinanceCtx, type FinanceScope } from '../core/context';
import { formatMoney } from '../core/money';
import { studentLabels } from '../core/people';
import { isOverdue } from './documents';
import { buildBill, loadAwards, loadEngine } from './engine';
import { getStudentAssignment, toAssignmentDTO } from './assignment.service';
import { sessionMonths } from './schedule';
import { ConcessionAward, ConcessionPolicy, FeeDocument, FeeDocumentLine, FeePlan, FeePlanVersion, FinancialAdjustment, StudentLedgerEntry, type ConcessionAwardDoc, type ConcessionPolicyDoc, type FeeDocumentDoc, type FeeDocumentLineDoc, type FeePlanDoc, type FeePlanVersionDoc, type StudentLedgerEntryDoc } from './models';

/**
 * Reading a student's money (FEE-12 to 14). Every balance here is WORKED OUT from bills and ledger rows. There is no stored total and
 * no "edit outstanding amount". The student's account, the explanation and the aging report all come from the same rows, so they
 * agree with each other (a test proves it).
 */

const isDues = (k: string) => (DUES_LEDGER_KINDS as readonly string[]).includes(k);
const isAdvance = (k: string) => (ADVANCE_LEDGER_KINDS as readonly string[]).includes(k);

interface Placement {
  locationId: string | null;
  classOfferingId: string | null;
  className: string | null;
  sessionId: string | null;
}

/** Where the student is now: the open enrollment, or the latest one when they have left. */
export async function placementOf(f: FinanceCtx, studentId: string): Promise<Placement> {
  const enrollments = await StudentEnrollment.find({ tenantId: f.tenantId, studentId }).sort({ effectiveFrom: -1 }).lean<StudentEnrollmentDoc[]>();
  const e = enrollments.find((x) => x.state === 'OPEN') ?? enrollments[0];
  if (!e) return { locationId: null, classOfferingId: null, className: null, sessionId: null };
  const offering = await ClassOffering.findOne({ _id: e.classOfferingId, tenantId: f.tenantId }).select('displayName').lean<{ displayName: string }>();
  return { locationId: e.locationId, classOfferingId: e.classOfferingId, className: offering?.displayName ?? null, sessionId: e.academicSessionId };
}

/** The student, or a 404 for another school's id. A campus outside the caller's scope is refused (403). */
export async function loadStudentFor(ctx: ServiceContext, f: FinanceCtx, studentId: string): Promise<Placement> {
  const student = await Student.exists({ _id: studentId, tenantId: f.tenantId });
  if (!student) throw AppError.notFound('Student not found.');
  const placement = await placementOf(f, studentId);
  const scope = await financeScope(ctx);
  if (placement.locationId) await assertInScope(ctx, scope, placement.locationId, 'student', studentId);
  else if (!scope.all) throw new AppError('FORBIDDEN', "You don't have access to this campus.");
  return placement;
}

async function ledgerOf(f: FinanceCtx, studentId: string): Promise<StudentLedgerEntryDoc[]> {
  return StudentLedgerEntry.find({ tenantId: f.tenantId, studentId }).sort({ date: 1, seq: 1, createdAt: 1 }).lean<StudentLedgerEntryDoc[]>();
}

export interface Balances {
  billedPaise: number;
  concessionPaise: number;
  taxPaise: number;
  creditedPaise: number;
  paidPaise: number;
  outstandingPaise: number;
  overduePaise: number;
  advancePaise: number;
}

/** Every amount on a student's account, worked out from their bills and ledger rows. One place, so every screen agrees. */
export async function balancesOf(f: FinanceCtx, studentId: string, today: string): Promise<Balances> {
  const [ledger, docs] = await Promise.all([ledgerOf(f, studentId), FeeDocument.find({ tenantId: f.tenantId, studentId }).lean<FeeDocumentDoc[]>()]);
  const charged = docs.filter((d) => d.kind !== 'CREDIT_NOTE');
  return {
    billedPaise: charged.reduce((s, d) => s + d.totalPaise, 0), concessionPaise: charged.reduce((s, d) => s + d.discountPaise, 0), taxPaise: charged.reduce((s, d) => s + d.cgstPaise + d.sgstPaise + d.igstPaise, 0),
    creditedPaise: docs.filter((d) => d.kind === 'CREDIT_NOTE').reduce((s, d) => s + d.totalPaise, 0), paidPaise: charged.reduce((s, d) => s + d.paidPaise, 0),
    outstandingPaise: ledger.filter((e) => isDues(e.kind)).reduce((s, e) => s + e.amountPaise, 0), overduePaise: charged.filter((d) => isOverdue(d, today)).reduce((s, d) => s + d.balancePaise, 0),
    advancePaise: 0 - ledger.filter((e) => isAdvance(e.kind)).reduce((s, e) => s + e.amountPaise, 0),
  };
}

export async function computeAccount(ctx: ServiceContext, f: FinanceCtx, studentId: string, placement: Placement): Promise<StudentAccountDTO> {
  const today = await todayFor(ctx);
  const [labels, balances, assignment] = await Promise.all([studentLabels(f, [studentId]), balancesOf(f, studentId, today), getStudentAssignment(f, studentId)]);
  const upcoming = assignment ? await computeUpcoming(f, studentId, assignment, today) : { items: [], totalPaise: 0 };
  let planName = '';
  if (assignment) {
    const version = await FeePlanVersion.findOne({ _id: assignment.planVersionId, tenantId: f.tenantId }).select('planId').lean<Pick<FeePlanVersionDoc, 'planId'>>();
    planName = (await FeePlan.findOne({ _id: version?.planId, tenantId: f.tenantId }).select('name').lean<Pick<FeePlanDoc, 'name'>>())?.name ?? '';
  }
  return {
    studentId, studentName: labels.get(studentId)?.name ?? 'Student', admissionNumber: labels.get(studentId)?.admissionNumber ?? null, className: placement.className, locationId: placement.locationId,
    ...balances, expectedLaterPaise: upcoming.totalPaise, assignment: assignment ? toAssignmentDTO(assignment, planName) : null,
  };
}

export async function getStudentAccount(ctx: ServiceContext, studentId: string): Promise<StudentAccountDTO> {
  const f = await financeCtx(ctx);
  const placement = await loadStudentFor(ctx, f, studentId);
  return computeAccount(ctx, f, studentId, placement);
}

/** Months not billed yet, priced the way a bill would be. Shown as "expected later" and never counted as owed. */
async function computeUpcoming(f: FinanceCtx, studentId: string, assignment: NonNullable<Awaited<ReturnType<typeof getStudentAssignment>>>, today: string): Promise<UpcomingDTO> {
  const session = await AcademicSession.findOne({ _id: assignment.sessionId, tenantId: f.tenantId }).select('startDate endDate').lean<{ startDate: string; endDate: string }>();
  if (!session) return { items: [], totalPaise: 0 };
  const engine = await loadEngine(f, assignment.sessionId);
  const billed = new Set((await FeeDocument.find({ tenantId: f.tenantId, studentId, kind: 'BILL', sessionId: assignment.sessionId }).select('periodKey').lean<{ periodKey: string }[]>()).map((d) => d.periodKey));
  const awards = (await loadAwards(f, [studentId])).get(studentId) ?? [];
  const items: UpcomingDTO['items'] = [];
  for (const periodKey of sessionMonths(session)) {
    if (billed.has(periodKey) || periodKey < monthKeyOf(today)) continue;
    const out = buildBill(engine, { studentId, assignment, locationId: assignment.locationId, periodKey, issueDate: `${periodKey}-01`, dueOverride: null, awards });
    if (out.ok) items.push({ periodKey, dueDate: out.dueDate, totalPaise: out.totals.totalPaise, lines: out.lines.map((l) => ({ description: l.description, totalPaise: l.totalPaise })) });
  }
  return { items, totalPaise: items.reduce((s, i) => s + i.totalPaise, 0) };
}

export async function getUpcoming(ctx: ServiceContext, studentId: string): Promise<UpcomingDTO> {
  const f = await financeCtx(ctx);
  await loadStudentFor(ctx, f, studentId);
  const assignment = await getStudentAssignment(f, studentId);
  return assignment ? computeUpcoming(f, studentId, assignment, await todayFor(ctx)) : { items: [], totalPaise: 0 };
}

// ───────────────────────────────────────────────────────────── ledger, statement, explanation

async function entryDTOs(f: FinanceCtx, rows: StudentLedgerEntryDoc[]): Promise<LedgerEntryDTO[]> {
  const docs = new Map((await FeeDocument.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.documentId).filter((x): x is string => !!x) } }).select('number').lean<{ _id: string; number: string }[]>()).map((d) => [d._id, d.number]));
  return rows.map((e) => ({ entryId: e._id, date: e.date, kind: e.kind, amountPaise: e.amountPaise, documentId: e.documentId, documentNumber: e.documentId ? docs.get(e.documentId) ?? null : null, journalId: e.journalId, description: e.description }));
}

export async function getLedger(ctx: ServiceContext, studentId: string): Promise<LedgerEntryDTO[]> {
  const f = await financeCtx(ctx);
  await loadStudentFor(ctx, f, studentId);
  return entryDTOs(f, await ledgerOf(f, studentId));
}

export async function getStatement(ctx: ServiceContext, studentId: string, query: { from?: string | null | undefined; to?: string | null | undefined }): Promise<StatementDTO> {
  const f = await financeCtx(ctx);
  await loadStudentFor(ctx, f, studentId);
  const today = await todayFor(ctx);
  const from = query.from ?? '0000-01-01';
  const to = query.to ?? today;
  const all = await ledgerOf(f, studentId);
  const dues = all.filter((e) => isDues(e.kind));
  const label = (await studentLabels(f, [studentId])).get(studentId);
  return {
    studentId, studentName: label?.name ?? 'Student', from: query.from ?? '', to, openingPaise: dues.filter((e) => e.date < from).reduce((s, e) => s + e.amountPaise, 0),
    rows: await entryDTOs(f, dues.filter((e) => e.date >= from && e.date <= to)), closingPaise: dues.filter((e) => e.date <= to).reduce((s, e) => s + e.amountPaise, 0),
  };
}

export async function statementPdf(ctx: ServiceContext, studentId: string, query: { from?: string | null | undefined; to?: string | null | undefined }): Promise<Buffer> {
  const f = await financeCtx(ctx);
  const s = await getStatement(ctx, studentId, query);
  const lines = [f.entity.name, '', 'FEE STATEMENT', `Student: ${s.studentName}`, `Period: ${s.from || 'start'} to ${s.to}`, '', `Opening balance: ${formatMoney(s.openingPaise)}`, ...s.rows.map((r) => `${r.date}  ${r.description}  ${formatMoney(r.amountPaise)}`), '', `Closing balance: ${formatMoney(s.closingPaise)}`];
  return simplePdf(lines.slice(0, 44));
}

/** "Tuition ₹4,000 − Sibling concession ₹400 + Late fee ₹100 − Payment ₹3,700 = ₹0 left", each part linked to its bill or journal. */
export async function explainBalance(ctx: ServiceContext, studentId: string): Promise<BalanceExplanationDTO> {
  const f = await financeCtx(ctx);
  await loadStudentFor(ctx, f, studentId);
  const ledger = (await ledgerOf(f, studentId)).filter((e) => isDues(e.kind));
  const advance = 0 - (await ledgerOf(f, studentId)).filter((e) => isAdvance(e.kind)).reduce((s, e) => s + e.amountPaise, 0);
  const docIds = [...new Set(ledger.filter((e) => ['BILL', 'DEBIT_NOTE'].includes(e.kind)).map((e) => e.documentId).filter((x): x is string => !!x))];
  const lines = await FeeDocumentLine.find({ tenantId: f.tenantId, documentId: { $in: docIds } }).sort({ lineNo: 1 }).lean<FeeDocumentLineDoc[]>();
  const awardIds = [...new Set(lines.flatMap((l) => l.concessionAwardIds))];
  const awards = await ConcessionAward.find({ tenantId: f.tenantId, _id: { $in: awardIds } }).select('policyId').lean<Pick<ConcessionAwardDoc, '_id' | 'policyId'>[]>();
  const policies = new Map((await ConcessionPolicy.find({ tenantId: f.tenantId, _id: { $in: awards.map((a) => a.policyId) } }).select('name').lean<Pick<ConcessionPolicyDoc, '_id' | 'name'>[]>()).map((p) => [p._id, p.name]));
  const awardName = new Map(awards.map((a) => [a._id, policies.get(a.policyId) ?? 'Concession']));

  const out: BalanceExplanationDTO['lines'] = [];
  for (const e of ledger) {
    if (e.kind === 'BILL' || e.kind === 'DEBIT_NOTE') {
      for (const l of lines.filter((x) => x.documentId === e.documentId)) {
        out.push({ label: l.description, amountPaise: l.basePaise, sign: '+', documentId: e.documentId, journalId: e.journalId });
        if (l.discountPaise > 0) out.push({ label: `${[...new Set(l.concessionAwardIds.map((id) => awardName.get(id) ?? 'Concession'))].join(' + ') || 'Concession'}`, amountPaise: l.discountPaise, sign: '-', documentId: e.documentId, journalId: e.journalId });
        if (l.priceMode === 'EXCLUSIVE' && l.taxPaise > 0) out.push({ label: `GST on ${l.description}`, amountPaise: l.taxPaise, sign: '+', documentId: e.documentId, journalId: e.journalId });
      }
    } else out.push({ label: e.description, amountPaise: Math.abs(e.amountPaise), sign: e.amountPaise >= 0 ? '+' : '-', documentId: e.documentId, journalId: e.journalId });
  }
  const totalPaise = out.reduce((s, l) => s + (l.sign === '+' ? l.amountPaise : -l.amountPaise), 0);
  const sum = out.map((l, i) => `${i === 0 ? (l.sign === '-' ? '− ' : '') : l.sign === '+' ? ' + ' : ' − '}${l.label} ${formatMoney(l.amountPaise)}`).join('');
  return { studentId, lines: out, totalPaise, sentence: `${sum || 'Nothing billed yet'} = ${formatMoney(totalPaise)} left${advance > 0 ? ` (and ${formatMoney(advance)} held as an advance)` : ''}` };
}

// ───────────────────────────────────────────────────────────── bills (list, one, pdf)

async function toDocumentDTOs(f: FinanceCtx, docs: FeeDocumentDoc[], withLines: boolean, today: string): Promise<FeeDocumentDTO[]> {
  const [labels, lines] = await Promise.all([studentLabels(f, docs.map((d) => d.studentId)), withLines ? FeeDocumentLine.find({ tenantId: f.tenantId, documentId: { $in: docs.map((d) => d._id) } }).sort({ lineNo: 1 }).lean<FeeDocumentLineDoc[]>() : Promise.resolve([] as FeeDocumentLineDoc[])]);
  return docs.map((d) => ({
    documentId: d._id, number: d.number, kind: d.kind, studentId: d.studentId, studentName: labels.get(d.studentId)?.name ?? 'Student', periodKey: d.periodKey, issueDate: d.issueDate, dueDate: d.dueDate, status: d.status,
    totalPaise: d.totalPaise, paidPaise: d.paidPaise, creditedPaise: d.creditedPaise, balancePaise: d.balancePaise, overdue: isOverdue(d, today), parentDocumentId: d.parentDocumentId, journalId: d.journalId,
    isTaxInvoice: d.cgstPaise + d.sgstPaise + d.igstPaise > 0,
    lines: lines.filter((l) => l.documentId === d._id).map((l) => ({ lineId: l._id, feeHeadId: l.feeHeadId, description: l.description, basePaise: l.basePaise, discountPaise: l.discountPaise, taxableValuePaise: l.taxableValuePaise, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, igstPaise: l.igstPaise, taxPaise: l.taxPaise, totalPaise: l.totalPaise, explanation: l.explanation })),
  }));
}

export async function listDocuments(ctx: ServiceContext, query: ListDocumentsQuery): Promise<FeeDocumentListDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const today = await todayFor(ctx);
  const filter: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...scopeFilter(scope) };
  if (query.studentId) filter.studentId = query.studentId;
  if (query.locationId) filter.locationId = query.locationId;
  if (query.kind) filter.kind = query.kind;
  if (query.status) filter.status = query.status;
  if (query.periodKey) filter.periodKey = query.periodKey;
  if (query.overdue) Object.assign(filter, { balancePaise: { $gt: 0 }, status: { $ne: 'CANCELLED' }, overdueAfter: { $lt: today } });
  if (query.from || query.to) filter.issueDate = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) };
  const [rows, total] = await Promise.all([FeeDocument.find(filter).sort({ issueDate: -1, number: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<FeeDocumentDoc[]>(), FeeDocument.countDocuments(filter)]);
  const items = (await toDocumentDTOs(f, rows, false, today)).map(({ lines: _lines, ...rest }) => rest);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

async function loadDocument(ctx: ServiceContext, f: FinanceCtx, id: string): Promise<FeeDocumentDoc> {
  const doc = await FeeDocument.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<FeeDocumentDoc>();
  if (!doc) throw AppError.notFound('Bill not found.');
  await assertInScope(ctx, await financeScope(ctx), doc.locationId, 'fee_document', id);
  return doc;
}

export async function getDocument(ctx: ServiceContext, id: string): Promise<FeeDocumentDTO & { history: { adjustmentId: string; type: string; amountPaise: number; reason: string; newDocumentId: string; createdAt: string }[] }> {
  const f = await financeCtx(ctx);
  const doc = await loadDocument(ctx, f, id);
  const [dto] = await toDocumentDTOs(f, [doc], true, await todayFor(ctx));
  const history = await FinancialAdjustment.find({ tenantId: f.tenantId, documentId: id }).sort({ createdAt: 1 }).lean();
  return { ...dto!, history: history.map((h) => ({ adjustmentId: h._id, type: h.type, amountPaise: h.amountPaise, reason: h.reason, newDocumentId: h.newDocumentId, createdAt: new Date(h.createdAt).toISOString() })) };
}

/** A tax invoice shows the GSTIN and the tax split when any line carries tax; otherwise it is a plain fee bill. */
export async function documentPdf(ctx: ServiceContext, id: string): Promise<{ buffer: Buffer; fileName: string }> {
  const f = await financeCtx(ctx);
  const doc = await loadDocument(ctx, f, id);
  const [dto] = await toDocumentDTOs(f, [doc], true, await todayFor(ctx));
  const d = dto!;
  const title = d.kind === 'CREDIT_NOTE' ? 'CREDIT NOTE' : d.kind === 'DEBIT_NOTE' ? 'DEBIT NOTE' : d.isTaxInvoice ? 'TAX INVOICE' : 'FEE BILL';
  const lines = [
    f.entity.name, ...(d.isTaxInvoice && f.entity.gstin ? [`GSTIN: ${f.entity.gstin}`] : []), '', title, `Number: ${d.number}`, `Date: ${d.issueDate}   Due: ${d.dueDate}`, `Student: ${d.studentName}`, '',
    ...d.lines.flatMap((l) => [`${l.description}  ${formatMoney(l.basePaise)}`, ...(l.discountPaise ? [`   Concession  -${formatMoney(l.discountPaise)}`] : []), ...(d.isTaxInvoice && l.taxPaise ? [`   GST (CGST ${formatMoney(l.cgstPaise)}, SGST ${formatMoney(l.sgstPaise)}${l.igstPaise ? `, IGST ${formatMoney(l.igstPaise)}` : ''})`] : [])]),
    '', `Total: ${formatMoney(d.totalPaise)}`, `Paid: ${formatMoney(d.paidPaise)}   Balance: ${formatMoney(d.balancePaise)}`,
  ];
  return { buffer: simplePdf(lines.slice(0, 44)), fileName: `${d.number.replace(/\//g, '-')}.pdf` };
}

// ───────────────────────────────────────────────────────────── outstanding and aging (FEE-14)

export const bucketOf = (overdueAfter: string, asOf: string): AgingBucket => {
  const late = daysBetween(overdueAfter, asOf);
  return late <= 0 ? 'CURRENT' : late <= 30 ? 'D1_30' : late <= 60 ? 'D31_60' : late <= 90 ? 'D61_90' : 'D90_PLUS';
};

export async function outstanding(ctx: ServiceContext, query: { locationId?: string | undefined; classOfferingId?: string | undefined; bucket?: AgingBucket | undefined; asOf?: string | null | undefined; page?: number | undefined; pageSize?: number | undefined }): Promise<OutstandingDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  if (query.locationId) await assertInScope(ctx, scope, query.locationId, 'location', query.locationId);
  const asOf = query.asOf ?? (await todayFor(ctx));
  const filter: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, kind: { $in: ['BILL', 'LATE_FEE', 'DEBIT_NOTE'] }, status: { $in: ['ISSUED', 'PARTIALLY_SETTLED'] }, balancePaise: { $gt: 0 }, ...scopeFilter(scope) };
  if (query.locationId) filter.locationId = query.locationId;
  if (query.classOfferingId) filter.classOfferingId = query.classOfferingId;
  const all = (await FeeDocument.find(filter).lean<FeeDocumentDoc[]>()).map((d) => ({ d, bucket: bucketOf(d.overdueAfter, asOf) }));
  const docs = query.bucket ? all.filter((x) => x.bucket === query.bucket) : all;
  const BUCKETS: AgingBucket[] = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'];
  const buckets = BUCKETS.map((bucket) => ({ bucket, count: docs.filter((x) => x.bucket === bucket).length, totalPaise: docs.filter((x) => x.bucket === bucket).reduce((s, x) => s + x.d.balancePaise, 0) }));
  const classNames = new Map((await ClassOffering.find({ tenantId: f.tenantId, _id: { $in: [...new Set(docs.map((x) => x.d.classOfferingId).filter((c): c is string => !!c))] } }).select('displayName').lean<{ _id: string; displayName: string }[]>()).map((c) => [c._id, c.displayName]));
  const byClass = [...docs.reduce((m, { d }) => {
    const key = d.classOfferingId ?? 'none';
    const cur = m.get(key) ?? { classOfferingId: d.classOfferingId ?? '', className: classNames.get(key) ?? 'No class', totalPaise: 0, students: new Set<string>() };
    cur.totalPaise += d.balancePaise;
    cur.students.add(d.studentId);
    return m.set(key, cur);
  }, new Map<string, { classOfferingId: string; className: string; totalPaise: number; students: Set<string> }>()).values()].map((c) => ({ classOfferingId: c.classOfferingId, className: c.className, totalPaise: c.totalPaise, students: c.students.size }));
  const byStudent = docs.reduce((m, x) => {
    const cur = m.get(x.d.studentId) ?? { outstandingPaise: 0, overduePaise: 0, oldest: null as string | null, bucket: 'CURRENT' as AgingBucket, d: x.d };
    cur.outstandingPaise += x.d.balancePaise;
    if (x.bucket !== 'CURRENT') cur.overduePaise += x.d.balancePaise;
    if (!cur.oldest || x.d.dueDate < cur.oldest) cur.oldest = x.d.dueDate;
    if (BUCKETS.indexOf(x.bucket) > BUCKETS.indexOf(cur.bucket)) cur.bucket = x.bucket;
    return m.set(x.d.studentId, cur);
  }, new Map<string, { outstandingPaise: number; overduePaise: number; oldest: string | null; bucket: AgingBucket; d: FeeDocumentDoc }>());
  const labels = await studentLabels(f, [...byStudent.keys()]);
  const pageSize = query.pageSize ?? 50;
  const rows = [...byStudent.entries()]
    .map(([studentId, v]) => ({ studentId, studentName: labels.get(studentId)?.name ?? 'Student', className: classNames.get(v.d.classOfferingId ?? '') ?? null, locationId: v.d.locationId, outstandingPaise: v.outstandingPaise, overduePaise: v.overduePaise, oldestDueDate: v.oldest, bucket: v.bucket }))
    .sort((a, b) => b.overduePaise - a.overduePaise || b.outstandingPaise - a.outstandingPaise)
    .slice(((query.page ?? 1) - 1) * pageSize, (query.page ?? 1) * pageSize);
  return { asOf, buckets, byClass, totalPaise: docs.reduce((s, x) => s + x.d.balancePaise, 0), rows };
}

/** A family is a VIEW: each linked child's own account, added up on screen. There is no family ledger. */
export async function familyView(ctx: ServiceContext, guardianPersonId: string): Promise<FamilyDTO> {
  const f = await financeCtx(ctx);
  const today = await todayFor(ctx);
  const person = await Person.findOne({ _id: guardianPersonId, tenantId: f.tenantId }).select('legalFirstName legalLastName preferredName').lean<{ legalFirstName: string; legalLastName: string; preferredName: string | null }>();
  if (!person) throw AppError.notFound('Guardian not found.');
  const links = await StudentGuardianLink.find({ tenantId: f.tenantId, guardianPersonId, cancelledAt: null, effectiveFrom: { $lte: today }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] }).select('studentId').lean<{ studentId: string }[]>();
  const live = new Set((await Student.find({ tenantId: f.tenantId, _id: { $in: links.map((l) => l.studentId) }, status: { $nin: EXITED_STUDENT_STATUSES } }).select('_id').lean<{ _id: string }[]>()).map((s) => s._id));
  const scope: FinanceScope = await financeScope(ctx);
  const children: StudentAccountDTO[] = [];
  for (const studentId of [...new Set(links.map((l) => l.studentId))].filter((id) => live.has(id))) {
    const placement = await placementOf(f, studentId);
    if (!scope.all && (!placement.locationId || !scope.locationIds.includes(placement.locationId))) continue;
    children.push(await computeAccount(ctx, f, studentId, placement));
  }
  if (children.length === 0) throw AppError.notFound('No children to show for this guardian.');
  const sum = (k: 'billedPaise' | 'paidPaise' | 'outstandingPaise' | 'overduePaise' | 'advancePaise') => children.reduce((s, c) => s + c[k], 0);
  return { guardianPersonId, guardianName: person.preferredName || `${person.legalFirstName} ${person.legalLastName}`.trim(), children, totals: { billedPaise: sum('billedPaise'), paidPaise: sum('paidPaise'), outstandingPaise: sum('outstandingPaise'), overduePaise: sum('overduePaise'), advancePaise: sum('advancePaise') } };
}

// ───────────────────────────────────────────────────────────── the Accounts list (FUX-07)

/**
 * Students of one campus with their money, found by name, admission number or parent. A finance user needs no Students permission:
 * the campus is checked against their finance scope instead. Every amount comes from `balancesOf`, the same worker as the account page.
 */
export async function listAccounts(ctx: ServiceContext, query: ListAccountsQuery): Promise<StudentAccountListDTO> {
  const f = await financeCtx(ctx);
  await assertInScope(ctx, await financeScope(ctx), query.locationId, 'location', query.locationId);
  const today = await todayFor(ctx);
  const page = await listStudentsAdmin(ctx, {
    page: query.page, pageSize: query.pageSize, locationId: query.locationId, ...(query.academicSessionId ? { academicSessionId: query.academicSessionId } : {}),
    ...(query.classOfferingId ? { classOfferingId: query.classOfferingId } : {}), ...(query.q ? { q: query.q } : {}), status: ['ACTIVE'],
  });
  const ids = page.items.map((s) => s.studentId);
  const links = await StudentGuardianLink.find({ tenantId: f.tenantId, studentId: { $in: ids }, isPrimary: true, cancelledAt: null, effectiveFrom: { $lte: today }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] }).select('studentId guardianPersonId').lean<{ studentId: string; guardianPersonId: string }[]>();
  const guardianOf = new Map(links.map((l) => [l.studentId, l.guardianPersonId]));
  const items = await Promise.all(page.items.map(async (s) => {
    const b = await balancesOf(f, s.studentId, today);
    return {
      studentId: s.studentId, studentName: s.displayName || s.fullName, admissionNumber: s.admissionNumber, className: s.classSection?.label ?? null, guardianName: s.primaryGuardianName,
      guardianPersonId: guardianOf.get(s.studentId) ?? null, billedPaise: b.billedPaise, paidPaise: b.paidPaise, outstandingPaise: b.outstandingPaise, overduePaise: b.overduePaise, advancePaise: b.advancePaise,
    };
  }));
  return { items, total: page.total, page: page.page, pageSize: page.pageSize };
}

/** "Billed this month" for the Overview: every bill, late fee and debit note issued in the school's current month, less nothing (credit notes are not subtracted). */
export async function financePulse(ctx: ServiceContext, query: { locationId?: string | undefined }): Promise<FinancePulseDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  if (query.locationId) await assertInScope(ctx, scope, query.locationId, 'location', query.locationId);
  const month = monthKeyOf(await todayFor(ctx));
  const filter: Record<string, unknown> = {
    tenantId: f.tenantId, legalEntityId: f.legalEntityId, kind: { $in: ['BILL', 'LATE_FEE', 'DEBIT_NOTE'] }, status: { $ne: 'CANCELLED' }, issueDate: { $gte: `${month}-01`, $lte: `${month}-31` }, ...scopeFilter(scope),
    ...(query.locationId ? { locationId: query.locationId } : {}),
  };
  const [row] = await FeeDocument.aggregate<{ total: number; n: number }>([{ $match: filter }, { $group: { _id: null, total: { $sum: '$totalPaise' }, n: { $sum: 1 } } }]);
  return { month, billedPaise: row?.total ?? 0, billCount: row?.n ?? 0 };
}
