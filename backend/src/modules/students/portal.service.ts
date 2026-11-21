import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { BulkInvitationData, BulkInvitationResultDTO, ParentAccessDTO, PortalState } from '@shared';
import { AppError } from '../../core/errors';
import { duplicateKeyFields } from '../../db/errors';
import { SKIP_TENANT_SCOPE } from '../../db/plugins/tenant-scope';
import { withTransaction } from '../../db/transaction';
import { issueAccountToken } from '../../platform/identity/account-tokens';
import { activationLink, sendSafely } from '../../platform/identity/notifier';
import { resendActivation } from '../../platform/identity/user-admin.service';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { User, type UserDoc } from '../../platform/users/user.model';
import { recordAudit } from '../audit/audit.service';
import { actorFrom } from '../../platform/rbac/tenant-context';
import { Person, type PersonDoc } from '../staff/person.model';
import { todayFor } from '../staff/status';
import { recordStudentAudit, type StudentAuditScope } from './audit';
import { fullNameOf } from './directory';
import { assertStudentWritable, loadGuardianLink, loadPerson, loadStudent } from './guards';
import { isOpenOn } from './rules';
import { Student, StudentEnrollment, StudentGuardianLink, StudentSectionAssignment, type StudentGuardianLinkDoc } from './student.models';

/**
 * SPM-11, SPM-12 — parent logins. A Parent is a normal `users` row with role PARENT and a `personId`. Activation, reset, suspend
 * and session revoke are the Module 3 code. Having a guardian does not mean having a login: access is turned on, per child,
 * by this service, and turned off per child without touching the login or the parent's other children.
 */

function isLive(link: StudentGuardianLinkDoc, today: string): boolean {
  return isOpenOn(link, today);
}

export function stateOf(link: Pick<StudentGuardianLinkDoc, 'portalEnabled' | 'portalRevokedAt'>, user: Pick<UserDoc, 'status'> | null): PortalState {
  if (link.portalEnabled) return user?.status === 'PENDING_ACTIVATION' ? 'INVITED' : 'ACTIVE';
  return link.portalRevokedAt ? 'REVOKED' : 'NOT_INVITED';
}

/** The login for a parent person: found by person, else by the (globally unique) email. Another tenant's or another kind of login never matches. */
async function findParentLogin(ctx: ServiceContext, person: PersonDoc, db?: ClientSession): Promise<UserDoc | null> {
  const byPerson = await User.findOne({ tenantId: ctx.tenantId, personId: person._id, role: 'PARENT' }).session(db ?? null).lean<UserDoc>();
  if (byPerson) return byPerson;
  if (!person.primaryEmail) return null;
  const byEmail = await User.findOne({ email: person.primaryEmail }).setOptions(SKIP_TENANT_SCOPE).session(db ?? null).lean<UserDoc>();
  if (!byEmail) return null;
  // A staff login, an admin, or somebody else's parent login must never be taken over by inviting a parent.
  if (byEmail.tenantId !== ctx.tenantId || byEmail.role !== 'PARENT' || (byEmail.personId && byEmail.personId !== person._id)) throw new AppError('PARENT_EMAIL_IN_USE');
  return byEmail;
}

interface EnableOutcome {
  linkId: string;
  userId: string;
  email: string | null;
  token: string | null;
  reusedAccount: boolean;
}

/**
 * Turns the portal on for one guardian link, inside the caller's transaction. Reuses the parent's login when there is one
 * (a sibling never makes a second account), otherwise makes a `PENDING_ACTIVATION` login and a single-use activation link.
 */
export async function enablePortalInTx(ctx: ServiceContext, db: ClientSession, linkId: string): Promise<EnableOutcome> {
  const link = await loadGuardianLink(ctx, linkId, db);
  assertStudentWritable(await loadStudent(ctx, link.studentId, db));
  const today = await todayFor(ctx, db);
  if (!isLive(link, today)) throw new AppError('GUARDIAN_LINK_NOT_ACTIVE');
  if (link.portalEnabled) throw new AppError('PORTAL_ALREADY_ENABLED');
  if (!link.canSeeAcademics && !link.canSeeFees) {
    throw AppError.validation({ canSeeAcademics: 'This parent cannot see academics or fees. Turn one of them on first, or leave them as an emergency contact only.' });
  }
  const person = await loadPerson(ctx, link.guardianPersonId, db);
  if (!person.primaryEmail) throw new AppError('GUARDIAN_EMAIL_REQUIRED', undefined, { fields: { email: 'Add this parent’s email address first.' } });

  let user = await findParentLogin(ctx, person, db);
  let token: string | null = null;
  const reusedAccount = Boolean(user);
  if (!user) {
    const [created] = await User.create(
      [{ _id: randomUUID(), tenantId: ctx.tenantId, email: person.primaryEmail, fullName: fullNameOf(person).slice(0, 100) || 'Parent', role: 'PARENT', personId: person._id, status: 'PENDING_ACTIVATION', createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session: db },
    );
    user = created!.toObject() as UserDoc;
    token = (await issueAccountToken(ctx.tenantId, user._id, 'ACTIVATION', db)).token;
    await recordAudit({ tenantId: ctx.tenantId, entityType: 'user', entityId: user._id, action: 'user.account_created', actor: actorFrom(ctx), changes: [{ field: 'role', from: null, to: 'PARENT' }, { field: 'status', from: null, to: 'PENDING_ACTIVATION' }], metadata: { subjectPersonId: person._id }, requestId: ctx.requestId }, db);
  } else {
    if (!user.personId) await User.updateOne({ _id: user._id, tenantId: ctx.tenantId }, { $set: { personId: person._id, updatedBy: ctx.userId } }, { session: db });
    // A disabled parent login is restored with a new link, the way Module 3 restores a returning employee.
    if (user.status === 'DISABLED') {
      await User.updateOne({ _id: user._id, tenantId: ctx.tenantId }, { $set: { status: 'PENDING_ACTIVATION', passwordHash: null, updatedBy: ctx.userId } }, { session: db });
      token = (await issueAccountToken(ctx.tenantId, user._id, 'ACTIVATION', db)).token;
    }
  }

  await StudentGuardianLink.updateOne({ _id: link._id, tenantId: ctx.tenantId }, { $set: { portalEnabled: true, portalRevokedAt: null, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
  await recordStudentAudit(ctx, db, {
    entityType: 'guardian_link',
    entityId: link._id,
    action: 'guardian_link.portal_enabled',
    changes: [{ field: 'portalEnabled', from: false, to: true }],
    studentId: link.studentId,
    metadata: { guardianPersonId: person._id, reusedAccount, userId: user._id },
  });
  return { linkId: link._id, userId: user._id, email: person.primaryEmail, token, reusedAccount };
}

async function afterCommit(ctx: ServiceContext, outcome: EnableOutcome) {
  // After the commit: a delivery problem must not undo the access (the admin can resend).
  if (outcome.token && outcome.email) await sendSafely({ tenantId: ctx.tenantId, to: outcome.email, template: 'ACTIVATION', link: activationLink(outcome.token) });
}

async function accessDto(ctx: ServiceContext, linkId: string, extra: { reusedAccount?: boolean; invitationSent?: boolean } = {}): Promise<ParentAccessDTO> {
  const link = await loadGuardianLink(ctx, linkId);
  return (await accessDtos(ctx, [link], extra))[0]!;
}

async function accessDtos(ctx: ServiceContext, links: StudentGuardianLinkDoc[], extra: { reusedAccount?: boolean; invitationSent?: boolean } = {}): Promise<ParentAccessDTO[]> {
  if (links.length === 0) return [];
  const today = await todayFor(ctx);
  const personIds = [...new Set(links.map((l) => l.guardianPersonId))];
  const [people, users] = await Promise.all([
    Person.find({ tenantId: ctx.tenantId, _id: { $in: personIds } }).lean<PersonDoc[]>(),
    User.find({ tenantId: ctx.tenantId, personId: { $in: personIds }, role: 'PARENT' }).lean<UserDoc[]>(),
  ]);
  const personOf = new Map(people.map((p) => [p._id, p]));
  const userOf = new Map(users.map((u) => [u.personId!, u]));
  return links.map((l) => {
    const person = personOf.get(l.guardianPersonId)!;
    const user = userOf.get(l.guardianPersonId) ?? null;
    return {
      guardianLinkId: l._id,
      studentId: l.studentId,
      guardianPersonId: l.guardianPersonId,
      fullName: fullNameOf(person),
      relationshipType: l.relationshipType,
      isPrimary: l.isPrimary,
      canSeeAcademics: l.canSeeAcademics,
      canSeeFees: l.canSeeFees,
      linkActive: isLive(l, today),
      portalEnabled: l.portalEnabled,
      portalState: stateOf(l, user),
      hasEmail: Boolean(person.primaryEmail),
      hasLogin: Boolean(user),
      accountStatus: user?.status ?? null,
      reusedAccount: extra.reusedAccount ?? false,
      invitationSent: extra.invitationSent ?? false,
    };
  });
}

// ───────────────────────────────────────────────────────────── routes' services

/** The Parent Access tab: each guardian of the child with their portal state. Contact values are not included. */
export async function listParentAccess(ctx: ServiceContext, studentId: string): Promise<ParentAccessDTO[]> {
  await loadStudent(ctx, studentId);
  const links = await StudentGuardianLink.find({ tenantId: ctx.tenantId, studentId, cancelledAt: null }).sort({ isPrimary: -1, communicationPriority: 1, _id: 1 }).lean<StudentGuardianLinkDoc[]>();
  const today = await todayFor(ctx);
  // Links that ended long ago are history, not something to invite.
  const rows = await accessDtos(ctx, links.filter((l) => isLive(l, today) || l.portalEnabled || l.portalRevokedAt));
  return rows.sort((a, b) => Number(b.linkActive) - Number(a.linkActive));
}

export async function enablePortal(ctx: ServiceContext, linkId: string): Promise<ParentAccessDTO> {
  let outcome: EnableOutcome;
  try {
    outcome = await withTransaction((db) => enablePortalInTx(ctx, db, linkId));
  } catch (err) {
    if (duplicateKeyFields(err)?.includes('email')) throw new AppError('PARENT_EMAIL_IN_USE');
    throw err;
  }
  await afterCommit(ctx, outcome);
  return accessDto(ctx, linkId, { reusedAccount: outcome.reusedAccount, invitationSent: Boolean(outcome.token) });
}

/** Removes access to this one child. The parent keeps the login and any other children. */
export async function revokePortalInTx(ctx: ServiceContext | StudentAuditScope, db: ClientSession, link: StudentGuardianLinkDoc, reason: string) {
  const tenantId = ctx.tenantId;
  await StudentGuardianLink.updateOne({ _id: link._id, tenantId }, { $set: { portalEnabled: false, portalRevokedAt: new Date() }, $inc: { version: 1 } }, { session: db });
  await recordStudentAudit(ctx, db, {
    entityType: 'guardian_link',
    entityId: link._id,
    action: 'guardian_link.portal_revoked',
    changes: [{ field: 'portalEnabled', from: true, to: false }],
    studentId: link.studentId,
    metadata: { guardianPersonId: link.guardianPersonId, reason },
  });
}

export async function revokePortal(ctx: ServiceContext, linkId: string): Promise<ParentAccessDTO> {
  await withTransaction(async (db) => {
    const link = await loadGuardianLink(ctx, linkId, db);
    // A student who has left has no access to remove: it was ended when they left.
    if (!link.portalEnabled) throw new AppError('PORTAL_NOT_ENABLED');
    await revokePortalInTx(ctx, db, link, 'ADMIN');
  });
  return accessDto(ctx, linkId);
}

export async function resendInvitation(ctx: ServiceContext, linkId: string): Promise<ParentAccessDTO> {
  const link = await loadGuardianLink(ctx, linkId);
  if (!link.portalEnabled) throw new AppError('PORTAL_NOT_ENABLED');
  const user = await User.findOne({ tenantId: ctx.tenantId, personId: link.guardianPersonId, role: 'PARENT' }).lean<UserDoc>();
  if (!user) throw new AppError('PORTAL_NOT_ENABLED');
  // Module 3's own resend: only a login that has not been activated needs a new link.
  await resendActivation(ctx, user._id);
  await withTransaction((db) =>
    recordStudentAudit(ctx, db, { entityType: 'guardian_link', entityId: link._id, action: 'guardian_link.invitation_resent', changes: [], studentId: link.studentId, metadata: { guardianPersonId: link.guardianPersonId } }),
  );
  return accessDto(ctx, linkId, { invitationSent: true });
}

// ───────────────────────────────────────────────────────────── bulk

/** Live links of students in a scope that could be invited: allowed to see something, no access yet, never removed. */
async function linkIdsForFilter(ctx: ServiceContext, filter: NonNullable<BulkInvitationData['filter']>): Promise<string[]> {
  const today = await todayFor(ctx);
  const enrollmentFilter: Record<string, unknown> = { tenantId: ctx.tenantId, state: 'OPEN' };
  if (filter.academicSessionId) enrollmentFilter.academicSessionId = filter.academicSessionId;
  if (filter.locationId) enrollmentFilter.locationId = filter.locationId;
  if (filter.classOfferingId) enrollmentFilter.classOfferingId = filter.classOfferingId;
  let studentIds: string[] = await StudentEnrollment.distinct('studentId', enrollmentFilter);
  if (filter.sectionId) {
    const inSection: string[] = await StudentSectionAssignment.distinct('studentId', { tenantId: ctx.tenantId, sectionId: filter.sectionId, cancelledAt: null, effectiveFrom: { $lte: today }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] });
    studentIds = studentIds.filter((id) => inSection.includes(id));
  }
  const active = await Student.find({ tenantId: ctx.tenantId, _id: { $in: studentIds }, status: { $in: ['ACTIVE', 'INACTIVE'] } }).select('_id').lean<{ _id: string }[]>();
  const links = await StudentGuardianLink.find({
    tenantId: ctx.tenantId,
    studentId: { $in: active.map((s) => s._id) },
    portalEnabled: false,
    portalRevokedAt: null,
    cancelledAt: null,
    effectiveFrom: { $lte: today },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }],
  })
    .select('_id canSeeAcademics canSeeFees')
    .limit(500)
    .lean<Pick<StudentGuardianLinkDoc, '_id' | 'canSeeAcademics' | 'canSeeFees'>[]>();
  return links.filter((l) => l.canSeeAcademics || l.canSeeFees).map((l) => l._id);
}

/** Invites many parents. Each parent is its own transaction, so one problem never stops the others; the summary lists what was skipped and why. */
export async function bulkInvite(ctx: ServiceContext, data: BulkInvitationData): Promise<BulkInvitationResultDTO> {
  const ids = data.guardianLinkIds ?? (await linkIdsForFilter(ctx, data.filter ?? {}));
  const result: BulkInvitationResultDTO = { invited: 0, reusedAccount: 0, skipped: [] };
  const names = new Map<string, string>();
  for (const linkId of [...new Set(ids)]) {
    try {
      const link = await StudentGuardianLink.findOne({ _id: linkId, tenantId: ctx.tenantId }).lean<StudentGuardianLinkDoc>();
      if (link) {
        const person = await Person.findOne({ _id: link.guardianPersonId, tenantId: ctx.tenantId }).lean<PersonDoc>();
        if (person) names.set(linkId, fullNameOf(person));
      }
      const outcome = await withTransaction((db) => enablePortalInTx(ctx, db, linkId));
      await afterCommit(ctx, outcome);
      if (outcome.reusedAccount) result.reusedAccount += 1;
      else result.invited += 1;
    } catch (err) {
      const message = err instanceof AppError ? err.message : 'Something went wrong.';
      result.skipped.push({ guardianLinkId: linkId, fullName: names.get(linkId) ?? null, reason: message });
    }
  }
  return result;
}
