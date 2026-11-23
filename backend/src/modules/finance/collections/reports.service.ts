import type { CollectionStatus, ReportDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { User } from '../../../platform/users/user.model';
import { ClassOffering } from '../../academic/offering.model';
import { auditFinance, assertInScope, financeCtx, financeScope, scopeFilter } from '../core/context';
import { proportion } from '../core/money';
import { studentLabels } from '../core/people';
import { BASIS, makeReport, reportCsv, sumRows } from '../core/report';
import { FeeDocument, FeeDocumentLine, FeeHead, StudentLedgerEntry, type FeeDocumentDoc, type FeeDocumentLineDoc, type FeeHeadDoc } from '../fees/models';
import { Collection, CollectionAllocation, PaymentClaim, RefundRequest, type CollectionAllocationDoc, type CollectionDoc, type PaymentClaimDoc, type RefundRequestDoc } from './models';

/** Collection reports (COL-11). Each one says what its numbers are. Only confirmed money is "received"; waiting money is shown apart. */

const FUNDED: CollectionStatus[] = ['POSTED', 'CLEARED', 'VERIFIED'];
type Query = { from?: string | null | undefined; to?: string | null | undefined; locationId?: string | undefined };

export async function collectionReport(ctx: ServiceContext, type: string, query: Query): Promise<ReportDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  if (query.locationId) await assertInScope(ctx, scope, query.locationId, 'report', query.locationId);
  const locFilter = query.locationId ? { locationId: query.locationId } : scopeFilter(scope);
  const dates = query.from || query.to ? { receivedOn: { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) } } : {};
  const base = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...locFilter };
  const range = { from: query.from, to: query.to };
  const money = (key: string, label: string) => ({ key, label, kind: 'money' as const });
  const text = (key: string, label: string) => ({ key, label, kind: 'text' as const });
  const num = (key: string, label: string) => ({ key, label, kind: 'number' as const });
  const date = (key: string, label: string) => ({ key, label, kind: 'date' as const });

  const funded = () => Collection.find({ ...base, ...dates, status: { $in: FUNDED } }).sort({ receivedOn: 1 }).lean<CollectionDoc[]>();

  switch (type) {
    case 'by-day': {
      const rows = new Map<string, { count: number; total: number }>();
      for (const c of await funded()) {
        const r = rows.get(c.receivedOn) ?? { count: 0, total: 0 };
        r.count += 1;
        r.total += c.amountPaise;
        rows.set(c.receivedOn, r);
      }
      const out = [...rows.entries()].map(([d, r]) => ({ date: d, count: r.count, totalPaise: r.total }));
      return makeReport({ type, title: 'Collections by day', basis: BASIS.RECEIVED, ...range, columns: [date('date', 'Date'), num('count', 'Payments'), money('totalPaise', 'Received')], rows: out.map((r) => ({ date: r.date, count: r.count, totalPaise: r.totalPaise })), totals: sumRows(out as never, ['count', 'totalPaise']) });
    }
    case 'by-method': {
      const rows = new Map<string, { count: number; total: number }>();
      for (const c of await funded()) {
        const r = rows.get(c.method) ?? { count: 0, total: 0 };
        r.count += 1;
        r.total += c.amountPaise;
        rows.set(c.method, r);
      }
      const out = [...rows.entries()].map(([method, r]) => ({ method, count: r.count, totalPaise: r.total }));
      return makeReport({ type, title: 'Collections by payment method', basis: BASIS.RECEIVED, ...range, columns: [text('method', 'Method'), num('count', 'Payments'), money('totalPaise', 'Received')], rows: out, totals: sumRows(out, ['count', 'totalPaise']) });
    }
    case 'by-cashier': {
      const rows = new Map<string, { count: number; total: number }>();
      for (const c of await funded()) {
        const key = c.createdBy ?? 'unknown';
        const r = rows.get(key) ?? { count: 0, total: 0 };
        r.count += 1;
        r.total += c.amountPaise;
        rows.set(key, r);
      }
      const names = new Map((await User.find({ tenantId: f.tenantId, _id: { $in: [...rows.keys()] } }).select('fullName').lean<{ _id: string; fullName: string }[]>()).map((u) => [u._id, u.fullName]));
      const out = [...rows.entries()].map(([id, r]) => ({ cashier: names.get(id) ?? 'Unknown', count: r.count, totalPaise: r.total }));
      return makeReport({ type, title: 'Collections by cashier', basis: BASIS.RECEIVED, ...range, columns: [text('cashier', 'Cashier'), num('count', 'Payments'), money('totalPaise', 'Received')], rows: out, totals: sumRows(out, ['count', 'totalPaise']) });
    }
    case 'by-class':
    case 'by-fee-head': {
      const collections = await funded();
      const allocs = await CollectionAllocation.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, collectionId: { $in: collections.map((c) => c._id) }, status: 'ACTIVE' }).lean<CollectionAllocationDoc[]>();
      const docs = new Map((await FeeDocument.find({ tenantId: f.tenantId, _id: { $in: allocs.map((a) => a.documentId) } }).lean<FeeDocumentDoc[]>()).map((d) => [d._id, d]));
      const totals = new Map<string, number>();
      if (type === 'by-class') {
        const offerings = new Map((await ClassOffering.find({ tenantId: f.tenantId, _id: { $in: [...new Set([...docs.values()].map((d) => d.classOfferingId).filter((x): x is string => !!x))] } }).select('displayName').lean<{ _id: string; displayName: string }[]>()).map((o) => [o._id, o.displayName]));
        for (const a of allocs) {
          const d = docs.get(a.documentId);
          const name = d?.classOfferingId ? offerings.get(d.classOfferingId) ?? 'Class' : 'No class';
          totals.set(name, (totals.get(name) ?? 0) + a.amountPaise);
        }
      } else {
        const lines = await FeeDocumentLine.find({ tenantId: f.tenantId, documentId: { $in: [...docs.keys()] } }).sort({ lineNo: 1 }).lean<FeeDocumentLineDoc[]>();
        const heads = new Map((await FeeHead.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).select('name').lean<Pick<FeeHeadDoc, '_id' | 'name'>[]>()).map((h) => [h._id, h.name]));
        for (const a of allocs) {
          const d = docs.get(a.documentId);
          const own = lines.filter((l) => l.documentId === a.documentId);
          if (!d || own.length === 0) continue;
          let left = a.amountPaise;
          own.forEach((l, i) => {
            const part = i === own.length - 1 ? left : proportion(a.amountPaise, l.totalPaise, d.totalPaise);
            left -= part;
            const name = heads.get(l.feeHeadId) ?? l.description;
            totals.set(name, (totals.get(name) ?? 0) + part);
          });
        }
      }
      const out = [...totals.entries()].map(([name, paise]) => ({ name, totalPaise: paise })).sort((a, b) => b.totalPaise - a.totalPaise);
      return makeReport({ type, title: type === 'by-class' ? 'Collections by class' : 'Collections by fee head', basis: BASIS.RECEIVED, ...range, columns: [text('name', type === 'by-class' ? 'Class' : 'Fee head'), money('totalPaise', 'Applied to bills')], rows: out, totals: sumRows(out, ['totalPaise']), notes: ['Money kept as an advance is not in this report until it is applied to a bill.'] });
    }
    case 'pending-verification': {
      const [collections, claims] = await Promise.all([
        Collection.find({ ...base, status: { $in: ['PENDING_VERIFICATION', 'RECEIVED', 'DEPOSITED'] } }).sort({ receivedOn: 1 }).lean<CollectionDoc[]>(),
        PaymentClaim.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(scopeFilter(scope)), status: { $in: ['PENDING_VERIFICATION', 'REPORTED'] }, collectionId: null }).sort({ paidOn: 1 }).lean<PaymentClaimDoc[]>(),
      ]);
      const labels = await studentLabels(f, [...collections.flatMap((c) => c.studentIds), ...claims.flatMap((c) => c.students.map((s) => s.studentId))]);
      const out = [
        ...collections.map((c) => ({ kind: c.method === 'CHEQUE' ? 'Cheque' : 'Payment', date: c.receivedOn, student: c.studentIds.map((id) => labels.get(id)?.name ?? 'Student').join(', '), method: c.method, reference: c.reference, amountPaise: c.amountPaise, flags: c.flags.join(', ') || null, status: c.status })),
        ...claims.map((c) => ({ kind: 'Parent report', date: c.paidOn, student: c.students.map((s) => labels.get(s.studentId)?.name ?? 'Student').join(', '), method: c.method, reference: c.reference, amountPaise: c.amountPaise, flags: c.flags.join(', ') || null, status: c.status })),
      ];
      return makeReport({ type, title: 'Payments waiting to be verified', basis: BASIS.PENDING, ...range, columns: [text('kind', 'Kind'), date('date', 'Date'), text('student', 'Student'), text('method', 'Method'), text('reference', 'Reference'), money('amountPaise', 'Amount'), text('flags', 'Flags'), text('status', 'Status')], rows: out, totals: sumRows(out, ['amountPaise']) });
    }
    case 'cheque-register': {
      const rows = await Collection.find({ ...base, ...dates, method: 'CHEQUE' }).sort({ receivedOn: 1 }).lean<CollectionDoc[]>();
      const out = rows.map((c) => ({ date: c.receivedOn, number: c.cheque?.number ?? '', bank: c.cheque?.bankName ?? '', chequeDate: c.cheque?.chequeDate ?? null, payer: c.payerName ?? c.cheque?.payerName ?? null, amountPaise: c.amountPaise, status: c.status, acknowledgement: c.provisionalNumber }));
      return makeReport({ type, title: 'Cheque register', basis: BASIS.PENDING, ...range, columns: [date('date', 'Received'), text('acknowledgement', 'Acknowledgement'), text('number', 'Cheque no.'), text('bank', 'Bank'), date('chequeDate', 'Cheque date'), text('payer', 'Payer'), money('amountPaise', 'Amount'), text('status', 'Status')], rows: out, totals: sumRows(out, ['amountPaise']), notes: ['A cheque counts as money only when its status is CLEARED.'] });
    }
    case 'advances': {
      const rows = await StudentLedgerEntry.aggregate<{ _id: string; sum: number }>([
        { $match: { tenantId: f.tenantId, legalEntityId: f.legalEntityId, kind: { $in: ['ADVANCE_IN', 'ADVANCE_USED', 'REFUND'] } } },
        { $group: { _id: '$studentId', sum: { $sum: '$amountPaise' } } },
      ]);
      const open = rows.filter((r) => r.sum < 0);
      const labels = await studentLabels(f, open.map((r) => r._id));
      const out = open.map((r) => ({ student: labels.get(r._id)?.name ?? 'Student', admissionNumber: labels.get(r._id)?.admissionNumber ?? null, advancePaise: -r.sum })).sort((a, b) => b.advancePaise - a.advancePaise);
      return makeReport({ type, title: 'Advances held for students', basis: BASIS.RECEIVED, columns: [text('student', 'Student'), text('admissionNumber', 'Admission no.'), money('advancePaise', 'Advance held')], rows: out, totals: sumRows(out, ['advancePaise']), notes: ['An advance is money the school owes back or will apply to a future bill. It is not income.'] });
    }
    case 'refund-register': {
      const rows = await RefundRequest.find({ ...base, ...(query.from || query.to ? { createdAt: { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(`${query.to}T23:59:59.999Z`) } : {}) } } : {}) }).sort({ createdAt: 1 }).lean<RefundRequestDoc[]>();
      const labels = await studentLabels(f, rows.map((r) => r.studentId));
      const out = rows.map((r) => ({ number: r.number, student: labels.get(r.studentId)?.name ?? 'Student', reason: r.reason, amountPaise: r.amountPaise, state: r.state, paidOn: r.paidOn }));
      return makeReport({ type, title: 'Refund register', basis: BASIS.RECEIVED, ...range, columns: [text('number', 'Refund no.'), text('student', 'Student'), text('reason', 'Reason'), money('amountPaise', 'Amount'), text('state', 'Status'), date('paidOn', 'Paid on')], rows: out, totals: sumRows(out, ['amountPaise']), notes: ['A refund counts as paid only when its status is PAID.'] });
    }
    default:
      throw AppError.notFound('Report not found.');
  }
}

/** A CSV export needs its own permission and is audited. */
export async function collectionReportCsv(ctx: ServiceContext, type: string, query: Query): Promise<string> {
  if (!can(ctx, 'finance:report:export')) throw new AppError('FORBIDDEN', undefined, { required: ['finance:report:export'] });
  const report = await collectionReport(ctx, type, query);
  const f = await financeCtx(ctx);
  await auditFinance(f, undefined, { action: 'report.exported', entityType: 'report', entityId: type, after: { rows: report.rows.length, from: query.from ?? null, to: query.to ?? null } });
  return reportCsv(report);
}
