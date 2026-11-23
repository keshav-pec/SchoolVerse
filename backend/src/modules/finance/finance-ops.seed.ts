import { bundlePermissions, permissionsFor, type FinanceBundle } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { User } from '../../platform/users/user.model';
import { todayFor } from '../staff/status';
import { Employee, type EmployeeDoc } from '../staff/employee.model';
import { updateRestricted } from '../staff/restricted.service';
import * as accountingModels from './accounting/models';
import { createExpense, createVendor, createVendorBill, listCategories } from './accounting/expense.service';
import * as bankingModels from './banking/models';
import { autoMatch } from './banking/reconcile.service';
import { importStatement } from './banking/statement.service';
import * as collectionModels from './collections/models';
import { createClaim, createCollection, verifyClaim, verifyCollection } from './collections/collection.service';
import { closePeriod } from './accounting/close.service';
import { decide } from './core/approvals.service';
import { createCashAccount } from './core/bank.service';
import { AccountingPeriod } from './core/models';
import * as payrollModels from './payroll/models';
import { StatutoryRule } from './payroll/models';
import { approveRule, approveStructureVersion, assignCompensation, createStructure, listComponents, putInput } from './payroll/setup.service';

/** Every Part 3 collection, so the demo reset clears them too (immutable ones through the raw collection). */
export const FINANCE_OPS_MODELS = [collectionModels, bankingModels, payrollModels, accountingModels].flatMap((mod) =>
  Object.values(mod).filter((m): m is { collection: { deleteMany: (q: object) => Promise<unknown> } } & object => typeof m === 'function' && 'collection' in m && 'modelName' in m),
);

const staffCtx = (ctx: ServiceContext, userId: string, bundles: FinanceBundle[]): ServiceContext => ({ ...ctx, userId, role: 'STAFF', permissions: [...new Set([...permissionsFor('STAFF'), ...bundlePermissions(bundles)])] });
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * Module 7, Part 4 demo data at Mohali, so every new screen opens with something real in it:
 * - a cash box; approver@ linked to the Principal (so the Approver reaches the Mohali payroll) and accounts@ also the Payroll Officer;
 * - salaries for the seven Mohali staff (Basic + 40% HRA, approved), this month's days for all but Rohan Gill, and Kavita Rao has no
 *   bank account: the payroll run opens with exactly two people who need action. The PF, ESI and PT rules stay demo values;
 * - money waiting: a payment reported at the office (staff claim) and a UPI payment entered at the counter, both not verified yet;
 * - a State Bank statement with five lines: the two payments, an SMS charge, interest, and an unknown credit nobody can explain;
 * - a vendor, a posted electricity expense and a supplies purchase whose GST waits for a "claim or not" decision.
 *
 * `clean` (what `npm run seed` uses) finishes all of that instead: everyone has a salary and this month's days, the PF/ESI/PT rules
 * are approved, both payments are verified and matched to the bank statement, the GST is claimed, and every finished month is closed.
 */
export async function seedFinanceOpsDemo(
  ctx: ServiceContext,
  input: { mohaliId: string; bankAccountId: string; userIdsByEmail: Record<string, string>; studentIds: string[]; billFor: (studentId: string) => Promise<string | null> },
  opts: { clean?: boolean } = {},
) {
  const today = await todayFor(ctx);
  const month = today.slice(0, 7);
  await createCashAccount(ctx, { label: 'Front office cash', locationIds: [input.mohaliId] });

  // ── people: the Principal is the Approver's employee record; the Principal gets made-up bank details like the others
  const byCode = async (code: string) => (await Employee.findOne({ tenantId: ctx.tenantId, employeeCode: code }).lean<EmployeeDoc>())!;
  const principal = await byCode('ADM-001');
  await User.updateOne({ _id: input.userIdsByEmail['approver@greenfield.demo'], tenantId: ctx.tenantId }, { $set: { personId: principal.personId } });
  await updateRestricted(ctx, principal._id, { bank: { accountHolderName: 'Principal Greenfield', accountNumber: '000000005699', ifsc: 'TEST0000001', bankName: 'Demo Bank' } });
  const approver = staffCtx(ctx, input.userIdsByEmail['approver@greenfield.demo']!, ['APPROVER']);
  const accounts = staffCtx(ctx, input.userIdsByEmail['accounts@greenfield.demo']!, ['ACCOUNTANT', 'FEE_MANAGER', 'COLLECTOR', 'PAYROLL_OFFICER']);

  // ── payroll: one approved structure, salaries for Mohali, this month's days for everyone but Rohan Gill (STF-001)
  const components = await listComponents(ctx);
  const basic = components.find((c) => c.code === 'BASIC')!;
  const hra = components.find((c) => c.code === 'HRA')!;
  const structure = await createStructure(ctx, { name: 'Teaching and office staff', effectiveFrom: '2026-04-01', items: [{ componentId: basic.componentId }, { componentId: hra.componentId, rateBps: 4000 }] });
  await approveStructureVersion(approver, structure.latestVersion!.versionId);
  const salaries: [string, number][] = [['ADM-001', 90_000], ['FAC-001', 52_000], ['FAC-002', 42_000], ['FAC-004', 50_000], ['STF-001', 24_000], ['STF-002', 22_000], ['STF-003', 35_000]];
  // Clean: the Chandigarh staff are paid too, so nobody is left without a salary.
  if (opts.clean) salaries.push(['FAC-003', 40_000], ['STF-004', 20_000], ['STF-005', 26_000]);
  for (const [code, rupees] of salaries) {
    const e = await byCode(code);
    await assignCompensation(ctx, { employeeId: e._id, structureVersionId: structure.latestVersion!.versionId, mode: 'MONTHLY', basicPaise: rupees * 100, overrides: [], effectiveFrom: '2026-04-01' });
    if (code !== 'STF-001' || opts.clean) await putInput(ctx, { employeeId: e._id, month, workingDays: null, paidLeaveDays: code === 'FAC-001' ? 1 : 0, lopDays: 0, unitsWorked: null, extras: [] });
  }

  // Clean: the demo values are approved, so payroll can run.
  if (opts.clean) for (const rule of await StatutoryRule.find({ tenantId: ctx.tenantId, state: 'DRAFT' }).lean<{ _id: string }[]>()) await approveRule(approver, rule._id);

  // ── money waiting for a check: a payment reported at the office, and a UPI payment entered at the counter
  const [first, second] = input.studentIds;
  const yesterday = shift(today, -1);
  const seen = { evidence: { seenOn: today, note: 'Seen in the State Bank statement.' }, bankAccountId: input.bankAccountId };
  if (first) {
    const claim = await createClaim(accounts, { students: [{ studentId: first, amountPaise: 400_000 }], method: 'UPI', amountPaise: 400_000, paidOn: yesterday, reference: 'UTR 4821 0000 1111' }, 'STAFF');
    if (opts.clean) await verifyClaim(ctx, claim.claimId, { amountSeenPaise: 400_000, ...seen });
  }
  if (second) {
    const bill = await input.billFor(second);
    const neft = await createCollection(accounts, { method: 'NEFT', amountPaise: 350_000, reference: 'NEFT 5566 7788', receivedOn: yesterday, bankAccountId: input.bankAccountId, payerName: 'Harjit Singh', allocations: [{ studentId: second, ...(bill ? { documentId: bill } : {}), amountPaise: 350_000 }] }, 'seed-neft-1');
    if (opts.clean) await verifyCollection(ctx, neft.collection.collectionId, { amountSeenPaise: 350_000, ...seen });
  }

  // ── the bank statement the accountant imported this morning
  // Clean: only the two fee payments, which match the payments above.
  const csv = [
    'Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt',
    `${dmy(yesterday)},UPI CR FROM PARENT,UTR482100001111,,4000.00`,
    `${dmy(yesterday)},NEFT CR HARJIT SINGH,NEFT55667788,,3500.00`,
    ...(opts.clean ? [] : [`${dmy(today)},SMS ALERT CHARGES,,11.80,`, `${dmy(today)},INTEREST CREDIT,,,125.00`, `${dmy(today)},NEFT CR UNKNOWN SENDER,NEFT998877,,2500.00`]),
  ].join('\r\n');
  await importStatement(accounts, input.bankAccountId, { buffer: Buffer.from(csv), originalname: 'state-bank-statement.csv' }, {});
  await autoMatch(accounts, { bankAccountId: input.bankAccountId });

  // ── spending: a vendor, an electricity bill paid from the bank, and a supplies purchase whose GST waits for a decision
  const categories = await listCategories(ctx);
  const cat = (code: string) => categories.find((c) => c.code === code)!.categoryId;
  const vendor = await createVendor(ctx, { name: 'Sharma Electricals', gstin: '03ABCDE1234F1Z5', stateCode: '03', contactName: 'Rakesh Sharma', phone: '+91 98140 00000' });
  await createExpense(ctx, { categoryId: cat('UTILITIES'), taxableValuePaise: 320_000, date: shift(today, -3), description: 'Electricity bill', locationId: input.mohaliId, paymentMode: 'BANK', bankAccountId: input.bankAccountId, gstRateBps: 0 });
  await createExpense(ctx, { categoryId: cat('SUPPLIES'), taxableValuePaise: 500_000, date: shift(today, -2), description: 'Lab bulbs and wiring', vendorId: vendor.vendorId, locationId: input.mohaliId, paymentMode: 'UNPAID', gstRateBps: 1800, itcStatus: opts.clean ? 'ELIGIBLE' : 'NEEDS_REVIEW' });
  await createVendorBill(ctx, { vendorId: vendor.vendorId, vendorBillNumber: 'SE/2026/118', date: shift(today, -5), dueDate: shift(today, 25), locationId: input.mohaliId, lines: [{ description: 'Annual electrical maintenance', categoryId: cat('MAINTENANCE'), taxableValuePaise: 3_000_000, gstRateBps: 0 }] });
  if (opts.clean) await closeFinishedMonths(ctx, approver, today);
  return { employees: salaries.length };
}

/** Clean demo only: closes every month that has ended (April to last month), each approved by the Approver. */
async function closeFinishedMonths(ctx: ServiceContext, approver: ServiceContext, today: string) {
  const done = await AccountingPeriod.find({ tenantId: ctx.tenantId, state: 'OPEN', endDate: { $lt: today } }).sort({ startDate: 1 }).lean<{ _id: string }[]>();
  for (const period of done) {
    const approvalId = await closePeriod(ctx, period._id, {}).then(
      () => null,
      (err: { code?: string; details?: { approvalId?: string } }) => {
        if (err.code !== 'APPROVAL_REQUIRED' || !err.details?.approvalId) throw err;
        return err.details.approvalId;
      },
    );
    if (!approvalId) continue;
    await decide(approver, approvalId, { decision: 'APPROVE' });
    await closePeriod(ctx, period._id, { approvalId });
  }
}
