import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { AuditActor } from '../../audit/audit.service';
import type { FinanceEventType, Permission } from '@shared';
import { AppError } from '../../../core/errors';
import { addDays } from '../../../core/dates';
import { logger } from '../../../core/logger';
import { duplicateKeyFields } from '../../../db/errors';
import { recordSecurityEvent } from '../../../platform/identity/security-events';
import { actorFrom, can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { Location, type LocationDoc } from '../../locations/location.model';
import { School } from '../../school/school.model';
import { currentLocationIds, findCallerEmployee } from '../../staff/access';
import { todayFor } from '../../staff/status';
import { OutboxEvent } from '../../spaces/space.models';
import { AccessGrant, AccountingPeriod, FinanceAudit, FinanceCounter, LegalEntity, type AccountingPeriodDoc, type LegalEntityDoc } from './models';

/**
 * What every finance service starts from: the caller, plus the school and its one legal entity. Every row written by finance stores
 * these ids. The legal entity is created the first time finance is opened, from the school profile.
 */
export interface FinanceCtx extends ServiceContext {
  schoolId: string;
  legalEntityId: string;
  entity: LegalEntityDoc;
}

/** GST state codes by state name, used to suggest the school's state from its primary campus address. */
export const GST_STATES: Record<string, string> = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', punjab: '03', chandigarh: '04', uttarakhand: '05', haryana: '06', delhi: '07', rajasthan: '08', 'uttar pradesh': '09', bihar: '10',
  sikkim: '11', 'arunachal pradesh': '12', nagaland: '13', manipur: '14', mizoram: '15', tripura: '16', meghalaya: '17', assam: '18', 'west bengal': '19', jharkhand: '20', odisha: '21',
  chhattisgarh: '22', 'madhya pradesh': '23', gujarat: '24', 'dadra and nagar haveli and daman and diu': '26', maharashtra: '27', 'andhra pradesh': '37', karnataka: '29', goa: '30',
  lakshadweep: '31', kerala: '32', 'tamil nadu': '33', puducherry: '34', 'andaman and nicobar islands': '35', telangana: '36', ladakh: '38',
};
const STATE_NAMES = Object.fromEntries(Object.entries(GST_STATES).map(([name, code]) => [code, name.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ And /g, ' and ')]));
export const stateCodeFor = (name: string | null | undefined): string | null => (name ? GST_STATES[name.trim().toLowerCase()] ?? null : null);
export const stateNameFor = (code: string | null | undefined): string | null => (code ? STATE_NAMES[code] ?? null : null);

export async function financeCtx(ctx: ServiceContext, db?: ClientSession): Promise<FinanceCtx> {
  let entity = await LegalEntity.findOne({ tenantId: ctx.tenantId }).session(db ?? null).lean<LegalEntityDoc>();
  if (!entity) {
    const school = await School.findOne({ tenantId: ctx.tenantId }).session(db ?? null).lean();
    if (!school) throw AppError.notFound('Set up the school profile before opening Finance.');
    const primary = await Location.findOne({ tenantId: ctx.tenantId, isPrimary: true }).session(db ?? null).lean<LocationDoc>();
    try {
      const [created] = await LegalEntity.create(
        [
          {
            _id: randomUUID(), tenantId: ctx.tenantId, schoolId: school._id, name: school.legalName, stateCode: stateCodeFor(primary?.address?.state),
            address: primary ? [primary.address.line1, primary.address.city, primary.address.state].filter(Boolean).join(', ') || null : null, createdBy: ctx.userId, updatedBy: ctx.userId,
          },
        ],
        { session: db },
      );
      entity = created!.toObject() as LegalEntityDoc;
    } catch (err) {
      if (!duplicateKeyFields(err)) throw err;
      entity = await LegalEntity.findOne({ tenantId: ctx.tenantId }).session(db ?? null).lean<LegalEntityDoc>();
      if (!entity) throw err;
    }
  }
  return { ...ctx, schoolId: entity.schoolId, legalEntityId: entity._id, entity };
}

// ───────────────────────────────────────────────────────────── audit and events

export interface FinanceAuditInput {
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Written in the caller's transaction, so the audit row and the change commit or roll back together. No secrets go in `before` or `after`. */
export async function auditFinance(f: FinanceCtx, db: ClientSession | undefined, input: FinanceAuditInput) {
  const actor: AuditActor = actorFrom(f);
  await FinanceAudit.create(
    [
      {
        tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId,
        actorId: actor === 'SYSTEM' ? null : actor.userId, actorRole: actor === 'SYSTEM' ? 'SYSTEM' : actor.role,
        action: input.action, entityType: input.entityType, entityId: input.entityId, before: input.before ?? null, after: input.after ?? null,
        correlationId: input.correlationId ?? f.requestId, metadata: input.metadata ?? {},
      },
    ],
    { session: db },
  );
}

/** A domain event on `outbox_events` (no broker yet). Ids only. */
export async function emitFinance(f: FinanceCtx, db: ClientSession | undefined, type: FinanceEventType | string, payload: Record<string, unknown>) {
  await OutboxEvent.create([{ tenantId: f.tenantId, type, payload: { legalEntityId: f.legalEntityId, ...payload } }], { session: db });
  logger.debug({ event: type, tenantId: f.tenantId }, 'finance event');
}

// ───────────────────────────────────────────────────────────── numbers

export const NUMBER_PREFIXES = ['BILL', 'CN', 'DN', 'JV', 'RCT', 'PSL', 'REF', 'ACK', 'EXP', 'VBL', 'VPY', 'OPN', 'PRN', 'SET'] as const;
export type NumberPrefix = (typeof NUMBER_PREFIXES)[number];

/**
 * Gap-free numbers such as `BILL/2026-27/000231`. The counter moves in the same transaction as the document, so a rolled-back
 * document gives its number back, and a number that was issued is never used again.
 */
export async function nextNumber(f: FinanceCtx, db: ClientSession, prefix: NumberPrefix, fyCode: string): Promise<string> {
  const row = await FinanceCounter.findOneAndUpdate(
    { tenantId: f.tenantId, legalEntityId: f.legalEntityId, key: `${prefix}:${fyCode}` },
    { $inc: { seq: 1 }, $setOnInsert: { schoolId: f.schoolId } },
    { upsert: true, returnDocument: 'after', session: db },
  ).lean();
  return `${prefix}/${fyCode}/${String(row!.seq).padStart(6, '0')}`;
}

/** The financial year a date belongs to, as `2026-27`. */
export function fyCodeFor(date: string, fyStartMonth: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const start = month >= fyStartMonth ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export async function periodFor(f: FinanceCtx, date: string, db?: ClientSession): Promise<AccountingPeriodDoc | null> {
  return AccountingPeriod.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, startDate: { $lte: date }, endDate: { $gte: date } }).session(db ?? null).lean<AccountingPeriodDoc>();
}

/** The first and last day of a month key such as `2026-11`. */
export function monthRange(periodKey: string): { start: string; end: string; days: number } {
  const [y, m] = periodKey.split('-').map(Number) as [number, number];
  const start = `${periodKey}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const end = addDays(next, -1);
  return { start, end, days: Number(end.slice(8, 10)) };
}

export const monthKeyOf = (date: string) => date.slice(0, 7);
export function addMonths(periodKey: string, n: number): string {
  const [y, m] = periodKey.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

// ───────────────────────────────────────────────────────────── campus scope

/**
 * Which campuses the caller may work in. A School Admin reaches every campus. A Staff user with finance bundles reaches the campuses
 * where they have an assignment running today, and a bundle's own campus list can only narrow that, never widen it. Anyone
 * outside the scope is refused (403) and a `CROSS_SCOPE_DENIED` event is written.
 */
export interface FinanceScope {
  all: boolean;
  locationIds: string[];
}

export async function financeScope(ctx: ServiceContext, db?: ClientSession): Promise<FinanceScope> {
  if (ctx.role === 'SCHOOL_ADMIN') return { all: true, locationIds: [] };
  const [grant, employee] = await Promise.all([AccessGrant.findOne({ tenantId: ctx.tenantId, userId: ctx.userId }).session(db ?? null).lean(), findCallerEmployee(ctx)]);
  const own = employee ? await currentLocationIds(ctx.tenantId, employee._id, await todayFor(ctx, db)) : [];
  const ids = grant?.locationIds ? own.filter((id) => grant.locationIds!.includes(id)) : own;
  return { all: false, locationIds: ids };
}

export const inScope = (scope: FinanceScope, locationId: string | null | undefined) => scope.all || !locationId || scope.locationIds.includes(locationId);

export async function assertInScope(ctx: ServiceContext, scope: FinanceScope, locationId: string, resource: string, targetId: string) {
  if (inScope(scope, locationId)) return;
  await recordSecurityEvent({ tenantId: ctx.tenantId, type: 'CROSS_SCOPE_DENIED', actorUserId: ctx.userId, targetId, ip: ctx.ip ?? null, outcome: 'DENIED', metadata: { resource, locationId } });
  throw new AppError('FORBIDDEN', "You don't have access to this campus.");
}

/** A campus id from the caller: another school's id is a 404, another campus of this school may be a 403 by scope. */
export async function loadLocationFor(ctx: ServiceContext, locationId: string, db?: ClientSession): Promise<LocationDoc> {
  const doc = await Location.findOne({ _id: locationId, tenantId: ctx.tenantId }).session(db ?? null).lean<LocationDoc>();
  if (!doc) throw AppError.notFound('Location not found.');
  return doc;
}

export async function assertLocationAccess(ctx: ServiceContext, locationId: string, db?: ClientSession) {
  await loadLocationFor(ctx, locationId, db);
  await assertInScope(ctx, await financeScope(ctx, db), locationId, 'location', locationId);
}

/** Filter fragment for a field that holds one location id. */
export const scopeFilter = (scope: FinanceScope, field = 'locationId'): Record<string, unknown> => (scope.all ? {} : { [field]: { $in: scope.locationIds } });

export function requireAny(ctx: ServiceContext, ...permissions: Permission[]) {
  if (!permissions.some((p) => can(ctx, p))) throw new AppError('FORBIDDEN', undefined, { required: permissions });
}

export const versionCheck = (current: number, sent: number) => {
  if (current !== sent) throw new AppError('VERSION_CONFLICT', undefined, { currentVersion: current });
};
