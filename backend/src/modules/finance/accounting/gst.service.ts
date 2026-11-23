import { randomUUID } from 'node:crypto';
import type { GstHead, GstPaymentDTO, ReportDTO, TaxReviewQueueDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { withTransaction } from '../../../db/transaction';
import { can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { todayFor } from '../../staff/status';
import { rolesMap } from '../core/chart.service';
import { auditFinance, financeCtx, financeScope, monthRange, scopeFilter, type FinanceCtx } from '../core/context';
import { BankAccount, JournalEntry, JournalLine, TaxCode, type BankAccountDoc, type TaxCodeDoc } from '../core/models';
import { formatMoney } from '../core/money';
import { postJournal } from '../core/posting';
import { BASIS, makeReport, reportCsv, sumRows } from '../core/report';
import { FeeDocument, FeeDocumentLine, FeeHead, type FeeDocumentDoc, type FeeDocumentLineDoc, type FeeHeadDoc } from '../fees/models';
import { GstPayment, TaxLine, type GstPaymentDoc, type TaxLineDoc } from './models';

/**
 * GST records and reports (TAX-04 to 09). Nothing is filed from here: no e-invoice, no filing, no ITC reversal rules (Rule 42 and 43 are an
 * accountant's job). The reports are working copies. A GST payment is a record of what the school did on the GST portal and at the bank.
 */

export const WORKING_COPY = 'Working copy — not a filed return';
const HEAD_ROLE: Record<GstHead, { output: string; input: string }> = { CGST: { output: 'OUTPUT_CGST', input: 'INPUT_CGST' }, SGST: { output: 'OUTPUT_SGST', input: 'INPUT_SGST' }, IGST: { output: 'OUTPUT_IGST', input: 'INPUT_IGST' } };

const dto = (p: GstPaymentDoc): GstPaymentDTO => ({ paymentId: p._id, month: p.month, kind: p.kind, head: p.head, amountPaise: p.amountPaise, challanRef: p.challanRef, bankAccountId: p.bankAccountId, paidOn: p.paidOn, journalId: p.journalId });

async function balanceOf(f: FinanceCtx, accountId: string) {
  const rows = await JournalLine.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, accountId }).select('debitPaise creditPaise').lean<{ debitPaise: number; creditPaise: number }[]>();
  return { debit: rows.reduce((s, r) => s + r.debitPaise, 0), credit: rows.reduce((s, r) => s + r.creditPaise, 0) };
}

export async function createGstPayment(ctx: ServiceContext, data: { month: string; kind: GstPaymentDTO['kind']; head: GstHead; amountPaise: number; bankAccountId?: string | undefined; challanRef?: string | null | undefined; paidOn?: string | null | undefined }): Promise<GstPaymentDTO> {
  const f = await financeCtx(ctx);
  const date = data.paidOn ?? (await todayFor(ctx));
  const row = await withTransaction(async (db) => {
    const roles = await rolesMap(f, db);
    const output = roles.get(HEAD_ROLE[data.head].output);
    const input = roles.get(HEAD_ROLE[data.head].input);
    if (!output || !input) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts is missing the GST accounts. Use the standard chart in Finance Settings.');
    const out = await balanceOf(f, output._id);
    if (data.amountPaise > out.credit - out.debit) throw new AppError('ALLOCATION_INVALID', `Only ${formatMoney(Math.max(0, out.credit - out.debit))} of ${data.head} output tax is still to be paid.`);
    let credit: string;
    if (data.kind === 'USE_ITC') {
      const inp = await balanceOf(f, input._id);
      if (data.amountPaise > inp.debit - inp.credit) throw new AppError('ALLOCATION_INVALID', `Only ${formatMoney(Math.max(0, inp.debit - inp.credit))} of ${data.head} input tax credit is available.`);
      credit = input._id;
    } else {
      const bank = await BankAccount.findOne({ _id: data.bankAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).session(db).lean<BankAccountDoc>();
      if (!bank) throw AppError.notFound('Bank account not found.');
      credit = bank.glAccountId;
    }
    const id = randomUUID();
    const { journal } = await postJournal(f, db, { eventType: data.kind === 'USE_ITC' ? 'gst.itc_used' : 'gst.paid', sourceKey: `gst_payment:${id}`, accountingDate: date, memo: `${data.head} for ${data.month}: ${data.kind === 'USE_ITC' ? 'input tax credit used' : 'paid'}${data.challanRef ? ` (${data.challanRef})` : ''}`, sourceType: 'gst_payment', sourceId: id, lines: [{ accountId: output._id, debitPaise: data.amountPaise }, { accountId: credit, creditPaise: data.amountPaise }] });
    const [p] = await GstPayment.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, month: data.month, kind: data.kind, head: data.head, amountPaise: data.amountPaise, challanRef: data.challanRef ?? null, bankAccountId: data.bankAccountId ?? null, paidOn: date, journalId: journal._id, createdBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'gst_payment.recorded', entityType: 'gst_payment', entityId: id, after: { month: data.month, kind: data.kind, head: data.head, amountPaise: data.amountPaise } });
    return p!.toObject() as GstPaymentDoc;
  });
  return dto(row);
}

export async function listGstPayments(ctx: ServiceContext, month?: string): Promise<GstPaymentDTO[]> {
  const f = await financeCtx(ctx);
  return (await GstPayment.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(month ? { month } : {}) }).sort({ paidOn: -1, createdAt: -1 }).limit(200).lean<GstPaymentDoc[]>()).map(dto);
}

// ───────────────────────────────────────────────────────────── what was charged: from the bills and credit notes, line by line

interface Outward {
  taxCodeId: string | null;
  name: string;
  category: string;
  rateBps: number;
  hsnSac: string | null;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

async function outwardFor(f: FinanceCtx, month: string | null, scopeLocs: string[] | null): Promise<Outward[]> {
  const range = month ? monthRange(month) : null;
  const docs = await FeeDocument.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, kind: { $in: ['BILL', 'LATE_FEE', 'DEBIT_NOTE', 'CREDIT_NOTE'] }, ...(range ? { issueDate: { $gte: range.start, $lte: range.end } } : {}), ...(scopeLocs ? { locationId: { $in: scopeLocs } } : {}) }).select('_id kind').lean<Pick<FeeDocumentDoc, '_id' | 'kind'>[]>();
  const kind = new Map(docs.map((d) => [d._id, d.kind]));
  const lines = await FeeDocumentLine.find({ tenantId: f.tenantId, documentId: { $in: docs.map((d) => d._id) }, isDeposit: false }).lean<FeeDocumentLineDoc[]>();
  const codes = new Map((await TaxCode.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<TaxCodeDoc[]>()).map((c) => [c._id, c]));
  const out = new Map<string, Outward>();
  for (const l of lines) {
    const sign = kind.get(l.documentId) === 'CREDIT_NOTE' ? -1 : 1;
    const code = l.taxCodeId ? codes.get(l.taxCodeId) : undefined;
    const key = `${l.taxCodeId ?? 'none'}|${l.rateBps}`;
    const row = out.get(key) ?? { taxCodeId: l.taxCodeId, name: code?.name ?? 'No tax code', category: code?.category ?? 'OUT_OF_SCOPE', rateBps: l.rateBps, hsnSac: code?.hsnSac ?? null, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
    row.taxablePaise += sign * l.taxableValuePaise;
    row.cgstPaise += sign * l.cgstPaise;
    row.sgstPaise += sign * l.sgstPaise;
    row.igstPaise += sign * l.igstPaise;
    out.set(key, row);
  }
  return [...out.values()];
}

export async function gstReport(ctx: ServiceContext, type: string, query: { month?: string | undefined }): Promise<ReportDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const locs = scope.all ? null : scope.locationIds;
  const month = query.month ?? (await todayFor(ctx)).slice(0, 7);
  const base = { from: month, to: month };
  const text = (key: string, label: string) => ({ key, label, kind: 'text' as const });
  const money = (key: string, label: string) => ({ key, label, kind: 'money' as const });
  const rate = (bps: number) => `${bps / 100}%`;
  switch (type) {
    case 'outward-summary': {
      const rows = (await outwardFor(f, month, locs)).filter((r) => r.category === 'TAXABLE');
      const out = rows.map((r) => ({ taxCode: r.name, rate: rate(r.rateBps), taxablePaise: r.taxablePaise, cgstPaise: r.cgstPaise, sgstPaise: r.sgstPaise, igstPaise: r.igstPaise }));
      return makeReport({ type, title: `${WORKING_COPY}: GST on fees charged, ${month}`, basis: BASIS.JOURNALS, ...base, columns: [text('taxCode', 'Tax code'), text('rate', 'Rate'), money('taxablePaise', 'Taxable value'), money('cgstPaise', 'CGST'), money('sgstPaise', 'SGST'), money('igstPaise', 'IGST')], rows: out, totals: sumRows(out, ['taxablePaise', 'cgstPaise', 'sgstPaise', 'igstPaise']), notes: ['Credit notes are taken off. Refundable deposits are not included.'] });
    }
    case 'exempt-and-nil-summary': {
      const rows = (await outwardFor(f, month, locs)).filter((r) => r.category !== 'TAXABLE');
      const out = rows.map((r) => ({ taxCode: r.name, category: r.category.replace('_', ' ').toLowerCase(), taxablePaise: r.taxablePaise }));
      return makeReport({ type, title: `${WORKING_COPY}: exempt, nil-rated and out-of-scope fees, ${month}`, basis: BASIS.JOURNALS, ...base, columns: [text('taxCode', 'Tax code'), text('category', 'Kind'), money('taxablePaise', 'Value')], rows: out, totals: sumRows(out, ['taxablePaise']) });
    }
    case 'hsn-summary': {
      const rows = (await outwardFor(f, month, locs)).filter((r) => r.category === 'TAXABLE');
      const by = new Map<string, { hsn: string; taxablePaise: number; taxPaise: number }>();
      for (const r of rows) {
        const key = r.hsnSac ?? 'Not set';
        const row = by.get(key) ?? { hsn: key, taxablePaise: 0, taxPaise: 0 };
        row.taxablePaise += r.taxablePaise;
        row.taxPaise += r.cgstPaise + r.sgstPaise + r.igstPaise;
        by.set(key, row);
      }
      const out = [...by.values()];
      return makeReport({ type, title: `${WORKING_COPY}: HSN/SAC summary, ${month}`, basis: BASIS.JOURNALS, ...base, columns: [text('hsn', 'HSN or SAC'), money('taxablePaise', 'Taxable value'), money('taxPaise', 'Tax')], rows: out, totals: sumRows(out, ['taxablePaise', 'taxPaise']) });
    }
    case 'itc-register': {
      const lines = await TaxLine.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, month, voided: false, ...scopeFilter(scope) }).sort({ date: 1 }).lean<TaxLineDoc[]>();
      const out = lines.map((l) => ({ date: l.date, source: l.sourceNumber, taxablePaise: l.taxableValuePaise, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, igstPaise: l.igstPaise, status: l.itcStatus }));
      return makeReport({ type, title: `${WORKING_COPY}: input tax credit register, ${month}`, basis: BASIS.JOURNALS, ...base, columns: [{ key: 'date', label: 'Date', kind: 'date' }, text('source', 'Source'), money('taxablePaise', 'Taxable value'), money('cgstPaise', 'CGST'), money('sgstPaise', 'SGST'), money('igstPaise', 'IGST'), text('status', 'Input credit')], rows: out, totals: sumRows(out, ['taxablePaise', 'cgstPaise', 'sgstPaise', 'igstPaise']), notes: ['Only ELIGIBLE lines are claimed. A school with mostly exempt income may claim very little: ask your accountant. Rule 42 and 43 are not worked out here.'] });
    }
    case 'liability-summary': {
      const outward = (await outwardFor(f, month, locs)).filter((r) => r.category === 'TAXABLE');
      const lines = await TaxLine.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, month, voided: false, itcStatus: 'ELIGIBLE' }).lean<TaxLineDoc[]>();
      const paid = await GstPayment.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, month }).lean<GstPaymentDoc[]>();
      const out = (['CGST', 'SGST', 'IGST'] as GstHead[]).map((h) => {
        const key = `${h.toLowerCase()}Paise` as 'cgstPaise';
        const output = outward.reduce((s, r) => s + r[key], 0);
        const eligible = lines.reduce((s, l) => s + l[key], 0);
        const usedItc = paid.filter((p) => p.head === h && p.kind === 'USE_ITC').reduce((s, p) => s + p.amountPaise, 0);
        const paidCash = paid.filter((p) => p.head === h && p.kind === 'PAY_LIABILITY').reduce((s, p) => s + p.amountPaise, 0);
        return { head: h, outputPaise: output, eligibleItcPaise: eligible, itcUsedPaise: usedItc, paidPaise: paidCash, stillToPayPaise: output - usedItc - paidCash };
      });
      return makeReport({ type, title: `${WORKING_COPY}: GST liability, ${month}`, basis: BASIS.JOURNALS, ...base, columns: [text('head', 'Tax'), money('outputPaise', 'Charged on fees'), money('eligibleItcPaise', 'Input credit available'), money('itcUsedPaise', 'Input credit used'), money('paidPaise', 'Paid in cash'), money('stillToPayPaise', 'Still to pay')], rows: out, totals: sumRows(out, ['outputPaise', 'eligibleItcPaise', 'itcUsedPaise', 'paidPaise', 'stillToPayPaise']) });
    }
    default:
      throw AppError.notFound('Report not found.');
  }
}

export async function gstReportCsv(ctx: ServiceContext, type: string, query: { month?: string | undefined }): Promise<string> {
  if (!can(ctx, 'finance:report:export')) throw new AppError('FORBIDDEN', undefined, { required: ['finance:report:export'] });
  const report = await gstReport(ctx, type, query);
  await auditFinance(await financeCtx(ctx), undefined, { action: 'report.exported', entityType: 'gst_report', entityId: type, after: { rows: report.rows.length, month: query.month ?? null } });
  return reportCsv(report);
}

// ───────────────────────────────────────────────────────────── the review queue (TAX-09)

export async function reviewQueue(ctx: ServiceContext): Promise<TaxReviewQueueDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const [heads, itc, outward] = await Promise.all([
    FeeHead.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE', taxCodeId: null, isRefundableDeposit: false }).lean<FeeHeadDoc[]>(),
    TaxLine.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, voided: false, itcStatus: 'NEEDS_REVIEW', ...scopeFilter(scope) }).lean<TaxLineDoc[]>(),
    outwardFor(f, null, scope.all ? null : scope.locationIds),
  ]);
  const taxable = outward.filter((o) => o.category === 'TAXABLE');
  const taxableTotal = taxable.reduce((s, o) => s + o.cgstPaise + o.sgstPaise + o.igstPaise, 0);
  const groups: TaxReviewQueueDTO['groups'] = [
    { key: 'FEE_HEADS_WITHOUT_TAX_CODE', title: 'Fee types with no tax setting', count: heads.length, items: heads.map((h) => ({ id: h._id, label: h.name, fix: { label: 'Add A Tax Code', path: '/finance/fees?tab=plans' } })) },
    { key: 'ITC_NEEDS_REVIEW', title: 'Input tax waiting for a decision', count: itc.length, items: itc.map((l) => ({ id: l._id, label: `${l.sourceNumber} · ${formatMoney(l.taxPaise)} tax`, fix: { label: 'Decide', path: '/finance/tax' } })) },
    { key: 'TAXABLE_WITHOUT_GSTIN', title: 'Taxable fees but no GST registration on record', count: taxableTotal > 0 && (!f.entity.gstRegistered || !f.entity.gstin) ? 1 : 0, items: taxableTotal > 0 && (!f.entity.gstRegistered || !f.entity.gstin) ? [{ id: f.legalEntityId, label: 'Add the school\'s GSTIN', fix: { label: 'Open School & Tax', path: '/finance/settings?tab=school-tax' } }] : [] },
  ];
  // The GST on bills must equal what the books hold for the same bills. A difference means something was posted outside the normal flow.
  const roles = await rolesMap(f);
  const outAccounts = ['OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST'].map((r) => roles.get(r)?._id).filter((x): x is string => !!x);
  const billJournals = (await JournalEntry.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, eventType: { $in: ['bill.issued', 'latefee.issued', 'credit_note.issued', 'debit_note.issued'] } }).select('_id').lean<{ _id: string }[]>()).map((j) => j._id);
  const ledger = await JournalLine.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, journalId: { $in: billJournals }, accountId: { $in: outAccounts } }).select('debitPaise creditPaise').lean<{ debitPaise: number; creditPaise: number }[]>();
  const books = ledger.reduce((s, l) => s + l.creditPaise - l.debitPaise, 0);
  const allOutward = await outwardFor(f, null, null);
  const docs = allOutward.reduce((s, o) => s + o.cgstPaise + o.sgstPaise + o.igstPaise, 0);
  const mismatch = scope.all && books !== docs;
  groups.push({ key: 'GST_DOES_NOT_MATCH_LEDGER', title: 'GST on bills does not match the books', count: mismatch ? 1 : 0, items: mismatch ? [{ id: 'gst', label: `Bills show ${formatMoney(docs)} but the books show ${formatMoney(books)}`, fix: { label: 'Open Journals', path: '/finance/accounting' } }] : [] });
  return { total: groups.reduce((s, g) => s + g.count, 0), groups };
}
