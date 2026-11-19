import {
  SETUP_STEP_COUNT,
  missingActivationFields,
  type CompleteSetupInput,
  type SchoolDTO,
  type SetupItemDTO,
  type SetupStatusDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import { actorFrom, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit } from '../audit/audit.service';
import { AcademicSession } from '../academic/session.model';
import { Location, type LocationDoc } from '../locations/location.model';
import { changeLocationStatusInSession } from '../locations/location.service';
import { findPrimary, lockSchoolLocations, switchPrimary } from '../locations/primary';
import { SchoolIdentifier } from '../school/school-identifier.model';
import { School } from '../school/school.model';
import { getSchoolOrThrow, toSchoolDTOFor } from '../school/school.service';

/** SCH-LOC-12 (wizard) and SCH-LOC-13 (overview): setup progress, completion and the setup checklist. */

// ───────────────────────────────────────────────────────────── progress

/** Remembers the wizard step so a refresh or re-login resumes where the admin left off. */
export async function saveSetupProgress(ctx: ServiceContext, schoolId: string, currentStep: number): Promise<SchoolDTO> {
  await getSchoolOrThrow(ctx, schoolId);
  const step = Math.min(Math.max(Math.trunc(currentStep), 1), SETUP_STEP_COUNT);
  // Never rewind a finished setup.
  await School.updateOne({ _id: schoolId, tenantId: ctx.tenantId, 'setup.status': 'IN_PROGRESS' }, { $set: { 'setup.currentStep': step } }, { timestamps: false });
  return toSchoolDTOFor(ctx, await getSchoolOrThrow(ctx, schoolId));
}

// ───────────────────────────────────────────────────────────── completion

const REQUIRED_PROFILE: { field: string; message: string }[] = [
  { field: 'displayName', message: 'School name is required.' },
  { field: 'legalName', message: 'Legal name is required.' },
  { field: 'schoolCode', message: 'School code is required.' },
  { field: 'primaryEmail', message: 'Primary email is required.' },
  { field: 'primaryPhone', message: 'Primary phone is required.' },
  { field: 'defaultTimezone', message: 'Time zone is required.' },
];

/**
 * One transaction: validate the profile and the Primary Location, activate the Primary Location
 * (which auto-assigns it as Primary when none exists), mark setup COMPLETED and write the audit event.
 * Completing an already-completed setup is a harmless no-op.
 */
export async function completeSetup(ctx: ServiceContext, schoolId: string, input: CompleteSetupInput = {}): Promise<SchoolDTO> {
  const school = await withTransaction(async (session) => {
    const before = await getSchoolOrThrow(ctx, schoolId, session);
    if (before.setup?.status === 'COMPLETED') return before;

    await lockSchoolLocations(session, ctx.tenantId, schoolId);
    const missing: Record<string, string> = {};

    for (const { field, message } of REQUIRED_PROFILE) {
      if (!String((before as unknown as Record<string, unknown>)[field] ?? '').trim()) missing[field] = message;
    }

    const existingPrimary = await findPrimary(session, ctx.tenantId, schoolId);
    let target: LocationDoc | null = null;
    if (!existingPrimary) {
      if (input.primaryLocationId) {
        target = await Location.findOne({ _id: input.primaryLocationId, tenantId: ctx.tenantId, schoolId }).session(session).lean<LocationDoc>();
      }
      if (!target) {
        missing.primaryLocation = 'Add a Primary Location before finishing setup.';
      } else if (target.status === 'ARCHIVED') {
        missing.primaryLocation = 'An archived location cannot be the Primary Location.';
        target = null;
      } else if (target.status !== 'ACTIVE') {
        for (const [field, message] of Object.entries(missingActivationFields(target))) missing[`primaryLocation.${field}`] = message;
      }
    }

    if (Object.keys(missing).length > 0) throw new AppError('SETUP_INCOMPLETE', undefined, { fields: missing });

    if (target) {
      if (target.status !== 'ACTIVE') await changeLocationStatusInSession(session, ctx, target._id, 'activate');
      // Activation makes the first active location Primary; if other active locations somehow exist, make it explicit.
      const afterActivation = await Location.findOne({ _id: target._id, tenantId: ctx.tenantId }).session(session).lean<LocationDoc>();
      if (afterActivation && !afterActivation.isPrimary && !(await findPrimary(session, ctx.tenantId, schoolId))) {
        await switchPrimary(session, ctx, afterActivation);
      }
    }

    const primary = await findPrimary(session, ctx.tenantId, schoolId);
    if (!primary) throw new AppError('SETUP_INCOMPLETE', undefined, { fields: { primaryLocation: 'Add a Primary Location before finishing setup.' } });

    const now = new Date();
    const after = await School.findOneAndUpdate(
      { _id: schoolId, tenantId: ctx.tenantId },
      { $set: { 'setup.status': 'COMPLETED', 'setup.currentStep': SETUP_STEP_COUNT, 'setup.completedAt': now, updatedBy: ctx.userId } },
      { session, returnDocument: 'after' },
    ).lean();
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'school',
        entityId: schoolId,
        action: 'school.setup_completed',
        actor: actorFrom(ctx),
        changes: [{ field: 'setup.status', from: 'IN_PROGRESS', to: 'COMPLETED' }],
        metadata: { primaryLocationId: primary._id, primaryLocationName: primary.displayName },
        requestId: ctx.requestId,
      },
      session,
    );
    return after!;
  });
  return toSchoolDTOFor(ctx, school);
}

// ───────────────────────────────────────────────────────────── overview checklist

type ItemSpec = Omit<SetupItemDTO, 'status'> & { done?: boolean; upcoming?: boolean };

/** Items owned by modules that don't exist yet. They show as "upcoming", never as failures. */
const UPCOMING_ITEMS: ItemSpec[] = [
  {
    key: 'buildings_rooms',
    label: 'Buildings & Rooms',
    description: 'Buildings and rooms for each campus.',
    weight: 10,
    module: 'buildings-rooms',
    href: null,
    upcoming: true,
  },
  {
    key: 'academic_calendar',
    label: 'Academic Calendar',
    description: 'Terms, holidays and key dates.',
    weight: 10,
    module: 'academic-calendar',
    href: null,
    upcoming: true,
  },
];

const hasText = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

export async function getSetupStatus(ctx: ServiceContext, schoolId: string): Promise<SetupStatusDTO> {
  const school = await getSchoolOrThrow(ctx, schoolId);
  const scope = { tenantId: ctx.tenantId, schoolId };

  const [activeIdentifiers, locations] = await Promise.all([
    SchoolIdentifier.countDocuments({ ...scope, status: 'ACTIVE' }),
    Location.find({ ...scope, status: { $ne: 'ARCHIVED' } }).lean<LocationDoc[]>(),
  ]);
  const primary = locations.find((l) => l.isPrimary && l.status === 'ACTIVE') ?? null;
  const addressMissing = (l: LocationDoc) => Object.keys(missingActivationFields({ phone: 'x', address: l.address })).some((k) => k.startsWith('address.'));
  const everyAddressComplete = locations.length > 0 && locations.every((l) => !addressMissing(l));

  // Academic Structure (Module 2): completed once a session is ACTIVE; pending while only drafts / published plans exist;
  // upcoming until the school starts planning one.
  const [activeSessions, plannedSessions] = await Promise.all([
    AcademicSession.countDocuments({ ...scope, status: 'ACTIVE' }),
    AcademicSession.countDocuments({ ...scope, status: { $in: ['DRAFT', 'PUBLISHED'] } }),
  ]);

  const specs: ItemSpec[] = [
    {
      key: 'school_profile',
      label: 'School Profile',
      description: 'Name, legal name, code and operational defaults.',
      weight: 15,
      module: 'school-setup',
      href: '/school-setup/profile',
      done: hasText(school.displayName) && hasText(school.legalName) && hasText(school.schoolCode) && hasText(school.defaultTimezone),
    },
    {
      key: 'school_contact',
      label: 'School Contact',
      description: 'Primary email and phone number.',
      weight: 10,
      module: 'school-setup',
      href: '/school-setup/profile',
      done: hasText(school.primaryEmail) && hasText(school.primaryPhone),
    },
    {
      key: 'official_identifiers',
      label: 'Official Identifiers',
      description: 'Affiliation, registration or UDISE+ numbers.',
      weight: 5,
      module: 'school-setup',
      href: '/school-setup/profile',
      done: activeIdentifiers > 0,
    },
    {
      key: 'primary_location',
      label: 'Primary Location',
      description: 'Your main campus. Exactly one active location is Primary.',
      weight: 20,
      module: 'school-setup',
      href: '/school-setup/locations',
      done: Boolean(primary),
    },
    {
      key: 'location_addresses',
      label: 'Location Addresses',
      description: 'Every campus has a complete address.',
      weight: 10,
      module: 'school-setup',
      href: '/school-setup/locations',
      done: everyAddressComplete,
    },
    {
      key: 'academic_structure',
      label: 'Academic Structure',
      description: 'Academic years, classes, sections and subjects.',
      weight: 20,
      module: 'academic-structure',
      href: '/academics',
      done: activeSessions > 0,
      upcoming: activeSessions === 0 && plannedSessions === 0,
    },
    ...UPCOMING_ITEMS,
  ];

  const items: SetupItemDTO[] = specs.map(({ done, upcoming, ...rest }) => ({
    ...rest,
    status: upcoming ? 'upcoming' : done ? 'completed' : 'pending',
  }));

  // Items whose module isn't built yet (upcoming, no route) can't be completed, so they must not hold the ring below 100%.
  const actionable = items.filter((i) => !(i.status === 'upcoming' && i.href === null));
  const totalWeight = actionable.reduce((n, i) => n + i.weight, 0);
  const doneWeight = actionable.filter((i) => i.status === 'completed').reduce((n, i) => n + i.weight, 0);
  const core = items.filter((i) => i.module === 'school-setup');
  const coreWeight = core.reduce((n, i) => n + i.weight, 0);
  const coreDone = core.filter((i) => i.status === 'completed').reduce((n, i) => n + i.weight, 0);

  return {
    schoolId,
    setupStatus: school.setup?.status ?? 'IN_PROGRESS',
    currentStep: school.setup?.currentStep ?? 1,
    completionPercent: Math.round((doneWeight / totalWeight) * 100),
    coreCompletionPercent: Math.round((coreDone / coreWeight) * 100),
    items,
    nextStep: items.find((i) => i.status === 'pending') ?? items.find((i) => i.status === 'upcoming') ?? null,
    summary: {
      schoolName: school.displayName,
      primaryLocation: primary ? { locationId: primary._id, displayName: primary.displayName, locationCode: primary.locationCode } : null,
      activeLocations: locations.filter((l) => l.status === 'ACTIVE').length,
      draftLocations: locations.filter((l) => l.status === 'DRAFT').length,
      totalLocations: locations.length,
    },
  };
}
