import type { PayslipDTO } from '@shared';
import { Money } from '@/components/finance/money';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

const ORDER = ['EARNING', 'ARREAR', 'DEDUCTION', 'RECOVERY'];
const TITLE: Record<string, string> = { EARNING: 'Pay', ARREAR: 'Arrears', DEDUCTION: 'Deductions', RECOVERY: 'Advance recovery' };

/** The lines of one payslip with the formula of each, and the sum. Shared by the payroll screens and My Salary. */
export function PayslipLines({ payslip, className }: { payslip: PayslipDTO; className?: string }) {
  return (
    <div className={cn('space-y-3', className)}>
      {ORDER.map((kind) => {
        const lines = payslip.lines.filter((l) => l.kind === kind);
        if (!lines.length) return null;
        return (
          <section key={kind} aria-label={TITLE[kind]}>
            <h4 className="mb-1 text-[13px] font-bold text-muted">{TITLE[kind]}</h4>
            <ul className="space-y-1 text-sm">
              {lines.map((l, i) => (
                <li key={`${l.label}-${i}`}>
                  <p className="flex justify-between gap-3">
                    <span>{l.label}</span>
                    <Money paise={l.amountPaise} />
                  </p>
                  {l.formula && <p className="text-[13px] text-muted">{l.formula}</p>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <p className="rounded-xl bg-canvas px-3 py-2 text-sm font-bold">
        Gross {formatMoney(payslip.grossPaise)} − Deductions {formatMoney(payslip.deductionsPaise)} = Net {formatMoney(payslip.netPaise)}
      </p>
    </div>
  );
}
