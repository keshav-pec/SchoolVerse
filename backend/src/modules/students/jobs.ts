import { DEFAULT_TIMEZONE } from '@shared';
import { todayIn } from '../../core/dates';
import { logger } from '../../core/logger';
import { SKIP_TENANT_SCOPE } from '../../db/plugins/tenant-scope';
import { withTransaction } from '../../db/transaction';
import { systemContext } from '../../platform/rbac/tenant-context';
import { timezonesByTenant } from '../staff/status';
import { completeWithdrawalInTx } from './exit.service';
import { cleanupExpiredStudentExports } from './export.service';
import { Student, type StudentDoc } from './student.models';

/**
 * Finishes every withdrawal whose leaving date has come (`WITHDRAWAL_INITIATED` → `WITHDRAWN` / `TRANSFERRED_OUT`): the open enrollment
 * and section close, subjects end, parents lose access to the child. Same pattern as `processDueExits` for staff: started from
 * `server.ts` (at startup and hourly), never from `app.ts`; tests call it directly. "Has come" uses each school's own time zone.
 * Returns how many students left.
 */
export async function processDueWithdrawals(now = new Date()): Promise<number> {
  const tenantIds = await Student.distinct('tenantId', { status: 'WITHDRAWAL_INITIATED' }).setOptions(SKIP_TENANT_SCOPE);
  if (tenantIds.length === 0) return 0;
  const zones = await timezonesByTenant(tenantIds);

  let left = 0;
  for (const tenantId of tenantIds) {
    const today = todayIn(zones.get(tenantId) ?? DEFAULT_TIMEZONE, now);
    const filter = { tenantId, status: 'WITHDRAWAL_INITIATED' as const, 'withdrawal.leavingDate': { $lte: today } };
    const due = await Student.find(filter).select('_id').lean<{ _id: string }[]>();
    for (const { _id } of due) {
      try {
        const done = await withTransaction(async (db) => {
          // Re-read inside the transaction: the withdrawal may have been cancelled or finished since the list was taken.
          const student = await Student.findOne({ ...filter, _id }).session(db).lean<StudentDoc>();
          if (!student) return false;
          await completeWithdrawalInTx(systemContext(tenantId), db, student, today, { scheduled: true });
          return true;
        });
        if (done) left += 1;
      } catch (err) {
        logger.error({ err, tenantId, studentId: _id }, 'could not complete a scheduled withdrawal');
      }
    }
  }
  return left;
}

const HOUR_MS = 60 * 60 * 1000;

/** Runs the hourly student jobs now and then every hour: scheduled withdrawals, and removing the files of expired exports. Returns a function that stops them. */
export function startStudentJobs(): () => void {
  const run = () =>
    Promise.all([
      processDueWithdrawals().then((n) => n > 0 && logger.info({ left: n }, 'completed scheduled withdrawals')),
      cleanupExpiredStudentExports().then((n) => n > 0 && logger.info({ removed: n }, 'removed expired student exports')),
    ]).catch((err) => logger.error({ err }, 'scheduled student job failed'));
  void run();
  const timer = setInterval(run, HOUR_MS);
  timer.unref();
  return () => clearInterval(timer);
}
