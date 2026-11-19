import { logger } from '../../core/logger';
import { SKIP_TENANT_SCOPE } from '../../db/plugins/tenant-scope';
import { withTransaction } from '../../db/transaction';
import { recordStaffAudit, systemScope } from './audit';
import { Employee, type EmployeeDoc } from './employee.model';
import { completeExit } from './lifecycle.service';
import { cleanupExpiredExports } from './export.service';
import { timezonesByTenant } from './status';
import { DEFAULT_TIMEZONE } from '@shared';
import { todayIn } from '../../core/dates';

/**
 * Moves every NOTICE_PERIOD employee whose exit date has arrived to EXITED (and runs the exit hooks, in the same
 * transaction). It is started from `server.ts` (at startup and hourly), never from `app.ts`; tests call it directly.
 *
 * "Arrived" uses each school's own time zone. Returns how many employees exited.
 */
export async function processDueExits(now = new Date()): Promise<number> {
  const tenantIds = await Employee.distinct('tenantId', { status: 'NOTICE_PERIOD' }).setOptions(SKIP_TENANT_SCOPE);
  if (tenantIds.length === 0) return 0;
  const zones = await timezonesByTenant(tenantIds);

  let exited = 0;
  for (const tenantId of tenantIds) {
    const today = todayIn(zones.get(tenantId) ?? DEFAULT_TIMEZONE, now);
    const dueFilter = { tenantId, status: 'NOTICE_PERIOD' as const, exitDate: { $lte: today } };
    const due = await Employee.find(dueFilter).select('_id').lean<{ _id: string }[]>();
    for (const { _id } of due) {
      try {
        const done = await withTransaction(async (db) => {
          // Re-read inside the transaction: the exit may have been cancelled or moved since the list was taken, or another
          // server may have finished it already. Either way this run must not exit them (again).
          const employee = await Employee.findOne({ ...dueFilter, _id }).session(db).lean<EmployeeDoc>();
          if (!employee) return false;
          const scope = systemScope(tenantId);
          await completeExit(employee, db, scope);
          await recordStaffAudit(scope, db, {
            entityType: 'employee',
            entityId: employee._id,
            action: 'employee.exited',
            changes: [{ field: 'status', from: 'NOTICE_PERIOD', to: 'EXITED' }],
            employeeId: employee._id,
            metadata: { exitDate: employee.exitDate, scheduled: true },
          });
          return true;
        });
        if (done) exited += 1;
      } catch (err) {
        logger.error({ err, tenantId, employeeId: _id }, 'could not complete a scheduled exit');
      }
    }
  }
  return exited;
}

const HOUR_MS = 60 * 60 * 1000;

/** Runs the hourly jobs now and then every hour: scheduled exits, and removing the files of expired exports. Returns a function that stops them. */
export function startStaffJobs(): () => void {
  const run = () =>
    Promise.all([
      processDueExits().then((n) => n > 0 && logger.info({ exited: n }, 'completed scheduled exits')),
      cleanupExpiredExports().then((n) => n > 0 && logger.info({ removed: n }, 'removed expired exports')),
    ]).catch((err) => logger.error({ err }, 'scheduled staff job failed'));
  void run();
  const timer = setInterval(run, HOUR_MS);
  timer.unref();
  return () => clearInterval(timer);
}
