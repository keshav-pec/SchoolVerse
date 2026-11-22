import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { seedTaxCodes } from '../tax/tax.service';
import { seedApprovalPolicies } from './approvals.service';
import { seedStandardChart } from './chart.service';
import { auditFinance, financeCtx } from './context';

/**
 * "Use the standard setup": the school-ready chart of accounts, the example tax codes and the default approval rules, in one click.
 * Safe to press twice. Nothing that already exists is changed. Tax values are EXAMPLES: the school confirms them with its accountant.
 */
export async function useStandardSetup(ctx: ServiceContext) {
  const f = await financeCtx(ctx);
  return withTransaction(async (db) => {
    const { added } = await seedStandardChart(f, db);
    await seedTaxCodes(f, db);
    await seedApprovalPolicies(f, db);
    await auditFinance(f, db, { action: 'finance.standard_setup', entityType: 'legal_entity', entityId: f.legalEntityId, after: { accountsAdded: added } });
    return { accountsAdded: added };
  });
}
