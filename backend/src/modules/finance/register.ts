import { bundlePermissions, type FinanceBundle } from '@shared';
import { registerLocationDependency } from '../dependencies/registry';
import { registerPermissionProvider } from '../../platform/rbac/permission-providers';
import { registerEnrollmentHook, registerStudentHistoryCheck } from '../students/hooks';
import { onEnrollmentSaved } from './fees/assignment.service';
import { AccessGrant, BankAccount, CashAccount, JournalLine } from './core/models';
import { FeeDocument, StudentFeeAssignment } from './fees/models';

let registered = false;

/**
 * Module 7 on the registries Modules 1 to 5 built:
 *   - finance bundles add permissions to a Staff login (read from the database on every request)
 *   - a student with bills, or a fee plan, is history and cannot be hard deleted
 *   - a campus with bank or cash accounts, bills or journal lines cannot be archived, and its code is locked
 *   - a new enrollment starts or ends a fee assignment (the Module 4 hook)
 */
export function registerFinanceDependencies() {
  if (registered) return;
  registered = true;

  registerPermissionProvider('finance', async (user) => {
    if (user.role !== 'STAFF') return [];
    const grant = await AccessGrant.findOne({ tenantId: user.tenantId, userId: user._id }).select('bundles').lean<{ bundles: FinanceBundle[] }>();
    return grant ? bundlePermissions(grant.bundles) : [];
  });

  registerStudentHistoryCheck('finance', async ({ tenantId, studentId, session }) => {
    const db = session ?? null;
    const [bill, assignment] = await Promise.all([FeeDocument.exists({ tenantId, studentId }).session(db), StudentFeeAssignment.exists({ tenantId, studentId }).session(db)]);
    return Boolean(bill || assignment);
  });

  registerEnrollmentHook('finance', onEnrollmentSaved);

  registerLocationDependency({
    key: 'finance.records',
    label: 'Finance records',
    message: (n) => `${n} finance record${n === 1 ? ' is' : 's are'} still linked to this location (bank accounts, bills or journals).`,
    async countActive({ tenantId, locationId, session }) {
      const db = session ?? null;
      const [banks, cash, open] = await Promise.all([
        BankAccount.countDocuments({ tenantId, locationIds: locationId, status: 'ACTIVE' }).session(db),
        CashAccount.countDocuments({ tenantId, locationIds: locationId, status: 'ACTIVE' }).session(db),
        FeeDocument.countDocuments({ tenantId, locationId, status: { $in: ['ISSUED', 'PARTIALLY_SETTLED'] }, balancePaise: { $gt: 0 } }).session(db),
      ]);
      return banks + cash + open;
    },
    async countAny({ tenantId, locationId, session }) {
      const db = session ?? null;
      const [banks, cash, bills, lines] = await Promise.all([
        BankAccount.countDocuments({ tenantId, locationIds: locationId }).session(db),
        CashAccount.countDocuments({ tenantId, locationIds: locationId }).session(db),
        FeeDocument.countDocuments({ tenantId, locationId }).session(db),
        JournalLine.countDocuments({ tenantId, locationId }).session(db),
      ]);
      return banks + cash + bills + lines;
    },
  });
}
