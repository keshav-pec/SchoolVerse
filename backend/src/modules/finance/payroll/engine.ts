import type { ComponentCalc, ComponentType, PayDayBasis, PayMode, PayrollRounding, RunExceptionDTO, RunType } from '@shared';
import { addDays, daysBetween } from '../../../core/dates';
import { formatMoney, percentOf, roundHalfUp } from '../core/money';

/**
 * The salary calculation. It is a pure function: the same inputs always give the same answer, so a run can be calculated again and again
 * until it is finalised. Every line carries its formula in words ("Basic ₹30,000 × 26/30 paid days = ₹26,000"), because "why is my
 * pay this amount?" must always have an answer. Gross, deductions, employer cost and net are four separate totals. What the employer
 * pays on top (employer PF and ESI) never reduces the employee's net.
 */

export interface PfParams { employeeBps: number; employerBps: number; wageCeilingPaise: number }
export interface EsiParams { employeeBps: number; employerBps: number; grossLimitPaise: number }
export interface PtParams { slabs: { fromPaise: number; toPaise: number | null; amountPaise: number }[] }

export interface EngineComponent {
  componentId: string;
  code: string;
  name: string;
  type: ComponentType;
  calc: ComponentCalc;
  pfWage: boolean;
  esiWage: boolean;
  prorate: boolean;
  glAccountId: string | null;
  amountPaise: number | null;
  rateBps: number | null;
}

export interface EngineInput {
  type: RunType;
  month: string;
  monthStart: string;
  monthEnd: string;
  daysInMonth: number;
  policy: { payDayBasis: PayDayBasis; rounding: PayrollRounding };
  employee: { joiningDate: string; exitDate: string | null };
  /** The last day paid, for a full and final settlement. */
  lastPaidDay?: string | null;
  compensation: { mode: PayMode; basicPaise: number } | null;
  components: EngineComponent[];
  input: { workingDays: number | null; paidLeaveDays: number; lopDays: number; unitsWorked: number | null; extras: { label: string; type: 'EARNING' | 'DEDUCTION'; amountPaise: number }[] } | null;
  rules: { pf: PfParams | null; esi: EsiParams | null; pt: PtParams | null; pfRuleId: string | null; esiRuleId: string | null; ptRuleId: string | null };
  tdsMonthlyPaise: number;
  advances: { advanceId: string; installmentPaise: number; remainingPaise: number }[];
  recoverAllAdvances?: boolean;
  arrears: { revisionId: string; amountPaise: number; label: string }[];
  oneOff: { label: string; type: 'EARNING' | 'DEDUCTION'; amountPaise: number }[];
}

export interface EngineLine {
  kind: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_COST' | 'RECOVERY' | 'ARREAR';
  componentKey: string;
  label: string;
  amountPaise: number;
  formula: string;
  glAccountId: string | null;
  ruleVersionId: string | null;
}

export interface EngineOutput {
  lines: EngineLine[];
  grossPaise: number;
  deductionsPaise: number;
  employerCostPaise: number;
  netPaise: number;
  fullMonthGrossPaise: number;
  paidNum: number;
  paidDen: number;
  exceptions: RunExceptionDTO[];
  advanceRecoveries: { advanceId: string; amountPaise: number }[];
}

const ex = (code: RunExceptionDTO['code'], level: RunExceptionDTO['level'], message: string, fixHint: string): RunExceptionDTO => ({ code, level, message, fixHint });
const dayWord = (n: number) => (n % 1 === 0 ? String(n) : `${Math.trunc(n)}.${String(Math.abs(Math.trunc((n % 1) * 10 + 0.5))).slice(0, 1)}`);

export function calculate(i: EngineInput): EngineOutput {
  const rnd = (paise: number) => (i.policy.rounding === 'NEAREST_RUPEE' ? roundHalfUp(paise, 100) * 100 : paise);
  const lines: EngineLine[] = [];
  const exceptions: RunExceptionDTO[] = [];
  const add = (l: Omit<EngineLine, 'glAccountId' | 'ruleVersionId'> & { glAccountId?: string | null; ruleVersionId?: string | null }) => lines.push({ glAccountId: null, ruleVersionId: null, ...l });
  const extraRun = i.type === 'SUPPLEMENTARY' || i.type === 'CORRECTION';

  // ───── days paid
  const empStart = i.employee.joiningDate > i.monthStart ? i.employee.joiningDate : i.monthStart;
  const lastDay = i.lastPaidDay ?? i.employee.exitDate;
  const empEnd = lastDay && lastDay < i.monthEnd ? lastDay : i.monthEnd;
  const employedDays = empEnd < empStart ? 0 : daysBetween(empStart, empEnd) + 1;
  const notEmployed = Math.max(0, i.daysInMonth - employedDays);
  if (notEmployed > 0 && !extraRun) {
    exceptions.push(ex('JOINED_OR_EXITED_THIS_MONTH', 'REVIEW', `${i.employee.joiningDate > i.monthStart ? 'Joined' : 'Leaves'} part-way through the month, so ${notEmployed} day${notEmployed === 1 ? '' : 's'} are not paid.`, 'Check the paid days, then carry on.'));
  }
  let paidNum = 0;
  let paidDen = 0;
  const mode = i.compensation?.mode ?? 'MONTHLY';
  if (!extraRun) {
    const finalSettlement = i.type === 'FULL_FINAL';
    const workingDays = i.input?.workingDays ?? null;
    paidDen = i.policy.payDayBasis === 'FIXED_30' ? 30 : i.policy.payDayBasis === 'WORKING_DAYS' ? workingDays ?? 0 : i.daysInMonth;
    if (!i.input && !finalSettlement) exceptions.push(ex('MISSING_INPUT', 'BLOCKER', 'The paid days for this month are not entered.', 'Enter this employee\'s days for the month, or use Mark Everyone Present.'));
    else if (mode === 'MONTHLY' && i.policy.payDayBasis === 'WORKING_DAYS' && !paidDen && !finalSettlement) exceptions.push(ex('MISSING_INPUT', 'BLOCKER', 'The number of working days is not entered.', 'Enter the working days for this month.'));
    else if (mode !== 'MONTHLY' && (i.input?.unitsWorked ?? null) === null && !finalSettlement) exceptions.push(ex('MISSING_INPUT', 'BLOCKER', `The ${mode === 'DAILY' ? 'days' : 'hours'} worked are not entered.`, `Enter the ${mode === 'DAILY' ? 'days' : 'hours'} worked.`));
    const lop = i.input?.lopDays ?? 0;
    const missedDays = paidDen === 0 ? 0 : i.policy.payDayBasis === 'WORKING_DAYS' ? roundHalfUp(notEmployed * paidDen, i.daysInMonth) : notEmployed;
    paidNum = paidDen === 0 ? 0 : Math.max(0, Math.min(paidDen, paidDen - lop - missedDays));
  }
  const fraction = (full: number) => (paidDen === 0 ? 0 : roundHalfUp(full * paidNum, paidDen));
  const daysText = paidDen ? `${dayWord(paidNum)}/${paidDen} paid days` : '';

  if (!extraRun && !i.compensation) exceptions.push(ex('NO_SALARY_ASSIGNED', 'BLOCKER', 'No salary structure is assigned to this employee.', 'Assign a salary structure under Employee Salary.'));

  // ───── earnings
  let pfWage = 0;
  let esiWage = 0;
  let fullMonthGross = 0;
  if (!extraRun && i.compensation) {
    if (mode === 'MONTHLY') {
      const basic = i.compensation.basicPaise;
      for (const c of i.components.filter((x) => x.type === 'EARNING')) {
        const isBasic = c.code === 'BASIC';
        const full = isBasic ? basic : c.calc === 'FIXED' ? c.amountPaise ?? 0 : percentOf(basic, c.rateBps ?? 0);
        const base = isBasic ? basic : full;
        const amount = rnd(c.prorate ? fraction(full) : full);
        fullMonthGross += full;
        const how = isBasic || c.calc === 'FIXED' ? `${c.name} ${formatMoney(base)}` : `${c.name} ${(c.rateBps ?? 0) / 100}% of basic ${formatMoney(basic)} = ${formatMoney(full)}`;
        const formula = c.prorate && paidNum < paidDen ? `${how} × ${daysText} = ${formatMoney(amount)}` : c.prorate ? `${how} (${daysText})` : how;
        if (amount !== 0) add({ kind: 'EARNING', componentKey: c.code, label: c.name, amountPaise: amount, formula, glAccountId: c.glAccountId });
        if (c.pfWage) pfWage += amount;
        if (c.esiWage) esiWage += amount;
      }
    } else {
      const units = i.input?.unitsWorked ?? 0;
      const amount = rnd(i.compensation.basicPaise * units);
      fullMonthGross = amount;
      if (amount !== 0) add({ kind: 'EARNING', componentKey: 'WAGES', label: mode === 'DAILY' ? 'Daily wages' : 'Hourly wages', amountPaise: amount, formula: `${formatMoney(i.compensation.basicPaise)} × ${dayWord(units)} ${mode === 'DAILY' ? 'days' : 'hours'} = ${formatMoney(amount)}` });
      const basicComp = i.components.find((c) => c.code === 'BASIC');
      if (basicComp?.pfWage) pfWage += amount;
      if (basicComp?.esiWage) esiWage += amount;
    }
  }
  for (const a of i.arrears) add({ kind: 'ARREAR', componentKey: 'ARREARS', label: a.label, amountPaise: a.amountPaise, formula: `${a.label}: ${formatMoney(a.amountPaise)}` });
  const extras = [...(i.input?.extras ?? []), ...i.oneOff];
  for (const e of extras.filter((x) => x.type === 'EARNING')) add({ kind: 'EARNING', componentKey: 'EXTRA', label: e.label, amountPaise: e.amountPaise, formula: `${e.label}: ${formatMoney(e.amountPaise)}` });
  const earnings = lines.filter((l) => l.kind === 'EARNING' || l.kind === 'ARREAR').reduce((s, l) => s + l.amountPaise, 0);
  const gross = earnings;

  // ───── deductions
  if (!extraRun && i.compensation) {
    const basic = i.compensation.basicPaise;
    for (const c of i.components.filter((x) => x.type === 'DEDUCTION')) {
      const amount = rnd(c.calc === 'FIXED' ? c.amountPaise ?? 0 : c.calc === 'PERCENT_OF_GROSS' ? percentOf(gross, c.rateBps ?? 0) : percentOf(basic, c.rateBps ?? 0));
      if (amount !== 0) add({ kind: 'DEDUCTION', componentKey: c.code, label: c.name, amountPaise: amount, formula: c.calc === 'FIXED' ? `${c.name} ${formatMoney(amount)}` : `${c.name} ${(c.rateBps ?? 0) / 100}% of ${c.calc === 'PERCENT_OF_GROSS' ? 'gross' : 'basic'} = ${formatMoney(amount)}`, glAccountId: c.glAccountId });
    }
    if (i.rules.pf && pfWage > 0) {
      const wage = Math.min(pfWage, i.rules.pf.wageCeilingPaise);
      const mine = rnd(percentOf(wage, i.rules.pf.employeeBps));
      const theirs = rnd(percentOf(wage, i.rules.pf.employerBps));
      const capNote = pfWage > i.rules.pf.wageCeilingPaise ? ` (wages capped at ${formatMoney(i.rules.pf.wageCeilingPaise)})` : '';
      add({ kind: 'DEDUCTION', componentKey: 'PF', label: 'Provident Fund', amountPaise: mine, formula: `PF ${i.rules.pf.employeeBps / 100}% of ${formatMoney(wage)}${capNote} = ${formatMoney(mine)}`, ruleVersionId: i.rules.pfRuleId });
      add({ kind: 'EMPLOYER_COST', componentKey: 'EMP_PF', label: 'Employer PF', amountPaise: theirs, formula: `Employer PF ${i.rules.pf.employerBps / 100}% of ${formatMoney(wage)} = ${formatMoney(theirs)}`, ruleVersionId: i.rules.pfRuleId });
    }
    if (i.rules.esi && esiWage > 0 && gross <= i.rules.esi.grossLimitPaise) {
      const mine = rnd(percentOf(esiWage, i.rules.esi.employeeBps));
      const theirs = rnd(percentOf(esiWage, i.rules.esi.employerBps));
      add({ kind: 'DEDUCTION', componentKey: 'ESI', label: 'ESI', amountPaise: mine, formula: `ESI ${i.rules.esi.employeeBps / 100}% of ${formatMoney(esiWage)} = ${formatMoney(mine)}`, ruleVersionId: i.rules.esiRuleId });
      add({ kind: 'EMPLOYER_COST', componentKey: 'EMP_ESI', label: 'Employer ESI', amountPaise: theirs, formula: `Employer ESI ${i.rules.esi.employerBps / 100}% of ${formatMoney(esiWage)} = ${formatMoney(theirs)}`, ruleVersionId: i.rules.esiRuleId });
    }
    if (i.rules.pt) {
      const slab = i.rules.pt.slabs.find((s) => gross >= s.fromPaise && (s.toPaise === null || gross <= s.toPaise));
      if (slab && slab.amountPaise > 0) add({ kind: 'DEDUCTION', componentKey: 'PT', label: 'Professional Tax', amountPaise: slab.amountPaise, formula: `Professional Tax for gross ${formatMoney(gross)} = ${formatMoney(slab.amountPaise)}`, ruleVersionId: i.rules.ptRuleId });
    }
    if (i.tdsMonthlyPaise > 0) add({ kind: 'DEDUCTION', componentKey: 'TDS', label: 'Income Tax (TDS)', amountPaise: i.tdsMonthlyPaise, formula: `TDS from the employee's declaration = ${formatMoney(i.tdsMonthlyPaise)}` });
  }
  for (const e of extras.filter((x) => x.type === 'DEDUCTION')) add({ kind: 'DEDUCTION', componentKey: 'EXTRA_DEDUCTION', label: e.label, amountPaise: e.amountPaise, formula: `${e.label}: ${formatMoney(e.amountPaise)}` });

  // ───── advance recovery: its own line, and never more than what is still owed
  const advanceRecoveries: { advanceId: string; amountPaise: number }[] = [];
  if (!extraRun || i.recoverAllAdvances) {
    for (const a of i.advances) {
      const amount = i.recoverAllAdvances ? a.remainingPaise : Math.min(a.installmentPaise, a.remainingPaise);
      if (amount > 0) {
        advanceRecoveries.push({ advanceId: a.advanceId, amountPaise: amount });
        add({ kind: 'RECOVERY', componentKey: 'ADVANCE', label: 'Salary advance recovery', amountPaise: amount, formula: i.recoverAllAdvances ? `Balance of the advance ${formatMoney(amount)} recovered in the final settlement` : `Instalment ${formatMoney(amount)} (${formatMoney(a.remainingPaise - amount)} left after this)` });
      }
    }
  }

  const deductions = lines.filter((l) => l.kind === 'DEDUCTION' || l.kind === 'RECOVERY').reduce((s, l) => s + l.amountPaise, 0);
  const employerCost = lines.filter((l) => l.kind === 'EMPLOYER_COST').reduce((s, l) => s + l.amountPaise, 0);
  const net = gross - deductions;
  if (net < 0) {
    const recovery = lines.filter((l) => l.kind === 'RECOVERY').reduce((s, l) => s + l.amountPaise, 0);
    if (recovery > 0 && gross - (deductions - recovery) >= 0) exceptions.push(ex('ADVANCE_EXCEEDS_NET', 'BLOCKER', `The advance instalment (${formatMoney(recovery)}) is more than the pay left after other deductions.`, 'Reduce the instalment or skip it this month.'));
    else exceptions.push(ex('NEGATIVE_NET', 'BLOCKER', `The deductions are ${formatMoney(deductions)} but the pay is only ${formatMoney(gross)}.`, 'Check the deductions and the days paid.'));
  }
  return { lines, grossPaise: gross, deductionsPaise: deductions, employerCostPaise: employerCost, netPaise: net, fullMonthGrossPaise: fullMonthGross, paidNum, paidDen, exceptions, advanceRecoveries };
}

/** Each of the 12 months of a financial year after (and including) `month`, for spreading a yearly tax estimate. */
export function monthsLeftInFy(month: string, fyStartMonth = 4): number {
  const m = Number(month.slice(5, 7));
  return m >= fyStartMonth ? 12 - (m - fyStartMonth) : fyStartMonth - m;
}

export { addDays };
