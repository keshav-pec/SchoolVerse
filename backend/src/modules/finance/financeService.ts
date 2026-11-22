import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { getFeeSummaryForParent, getStudentBalance, getStudentClearance } from './fees/parent.service';

/**
 * Money, for every other module (Transfer Certificate, Promotion, Reports, the Parent Portal).
 *
 *   DO NOT KEEP YOUR OWN FEE TOTALS. Ask this service. There is no `tc_fees` and no `portal_balances`: a second copy of a balance
 *   would drift from the books. Every answer here is worked out from bills and ledger rows, under the caller's own scope.
 */
export const financeService = {
  /** What a student owes, what is overdue and what the school holds for them as an advance. */
  getStudentBalance: (ctx: ServiceContext, studentId: string) => getStudentBalance(ctx, studentId),

  /** Clear, has dues, or has payments still being checked. Plus refundable advances and deposits. */
  getStudentClearance: (ctx: ServiceContext, studentId: string) => getStudentClearance(ctx, studentId),

  /** The signed-in parent's children with what each owes. Only children whose guardian link allows fees. */
  getFeeSummaryForParent: (ctx: ServiceContext) => getFeeSummaryForParent(ctx),
};
