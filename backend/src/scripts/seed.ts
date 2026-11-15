/**
 * Seeds two isolated demo tenants with one user per role, a School Master each, and the
 * PRD §19 standard location dataset (Mohali MOH primary/active, Chandigarh CHD active,
 * Panchkula PKL draft) for Greenfield. Greenfield's setup is completed; Riverside's is left mid-wizard.
 * Idempotent: re-running removes the previous demo data for these tenants first.
 *
 *   npm run seed
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createIdentifierSchema, createLocationSchema, createSchoolSchema, permissionsFor, type Role } from '@shared';
import { env } from '../config/env';
import { connectDatabase, disconnectDatabase } from '../db/connection';
import { AuditEvent } from '../modules/audit/audit.model';
import { seedAcademicDemo } from '../modules/academic/academic.seed';
import { seedReferenceData, seedStarterSubjects } from '../modules/academic/reference.seed';
import { LocationReference } from '../modules/dependencies/simulated-references';
import { GradeOffering, SectionOffering, SubjectOffering } from '../modules/academic/offering.model';
import { AcademicProgramme, SubjectChoiceConstraint, SubjectChoiceGroup } from '../modules/academic/rules.model';
import { BoardRuleVersion, EducationBoard } from '../modules/academic/reference.model';
import { AcademicSession, AcademicTerm } from '../modules/academic/session.model';
import { BoardSubjectDefinition, Subject } from '../modules/academic/subject.model';
import { Location } from '../modules/locations/location.model';
import { createLocation } from '../modules/locations/location.service';
import { SchoolIdentifier } from '../modules/school/school-identifier.model';
import { School } from '../modules/school/school.model';
import { createIdentifier, createSchool } from '../modules/school/school.service';
import { completeSetup, saveSetupProgress } from '../modules/setup/setup.service';
import type { ServiceContext } from '../platform/rbac/tenant-context';
import { hashPassword } from '../platform/auth/password';
import { Session } from '../platform/auth/session.model';
import { UserLocationAccess } from '../platform/rbac/user-location-access.model';
import { Tenant } from '../platform/tenants/tenant.model';
import { User } from '../platform/users/user.model';

export const DEMO_PASSWORD = 'Welcome@123';

interface DemoTenant {
  slug: string;
  name: string;
  users: { email: string; fullName: string; role: Role }[];
  school: Record<string, unknown>;
  identifiers?: Record<string, unknown>[];
  /** `true` = first-time setup already finished; otherwise the admin is sent to the wizard (resuming at `resumeStep`). */
  setupComplete: boolean;
  resumeStep?: number;
  locations: Record<string, unknown>[];
}

const DEMO_TENANTS: DemoTenant[] = [
  {
    slug: 'greenfield-public-school',
    name: 'Greenfield Public School',
    school: {
      schoolCode: 'GPS',
      legalName: 'Greenfield Educational Society',
      displayName: 'Greenfield Public School',
      shortName: 'GPS',
      primaryEmail: 'office@greenfield.demo',
      primaryPhone: '+91 98140 11000',
      websiteUrl: 'greenfield.demo',
    },
    setupComplete: true,
    identifiers: [
      { identifierType: 'Affiliation Number', identifierValue: '1630457', issuingAuthority: 'CBSE', issueDate: '2012-04-01' },
      { identifierType: 'UDISE+ Code', identifierValue: '03200101203', issuingAuthority: 'Ministry of Education' },
    ],
    // PRD §19 standard seed dataset.
    locations: [
      {
        displayName: 'Mohali Campus',
        locationCode: 'MOH',
        locationType: 'MAIN_CAMPUS',
        intent: 'ACTIVE',
        openingDate: '2012-04-01',
        phone: '+91 98140 11001',
        email: 'mohali@greenfield.demo',
        address: { line1: 'Plot 12, Sector 70', city: 'Mohali', district: 'SAS Nagar', state: 'Punjab', postalCode: '160071', country: 'IN' },
        latitude: 30.7046,
        longitude: 76.7179,
      },
      {
        displayName: 'Chandigarh Campus',
        locationCode: 'CHD',
        locationType: 'BRANCH_CAMPUS',
        intent: 'ACTIVE',
        openingDate: '2018-04-01',
        phone: '+91 98140 11002',
        email: 'chandigarh@greenfield.demo',
        address: { line1: 'SCO 45, Sector 17-C', city: 'Chandigarh', state: 'Chandigarh', postalCode: '160017', country: 'IN' },
      },
      {
        displayName: 'Panchkula Campus',
        locationCode: 'PKL',
        locationType: 'BRANCH_CAMPUS',
        intent: 'DRAFT',
        address: { city: 'Panchkula', state: 'Haryana', country: 'IN' },
        notes: 'Opening planned for the 2027-28 session.',
      },
    ],
    users: [
      { email: 'admin@greenfield.demo', fullName: 'Aarav Mehta', role: 'SCHOOL_ADMIN' },
      { email: 'faculty@greenfield.demo', fullName: 'Priya Sharma', role: 'FACULTY' },
      { email: 'staff@greenfield.demo', fullName: 'Rohan Gill', role: 'STAFF' },
      { email: 'parent@greenfield.demo', fullName: 'Simran Kaur', role: 'PARENT' },
    ],
  },
  {
    slug: 'riverside-academy',
    name: 'Riverside Academy',
    // Left mid-setup on purpose: signing in as this admin shows the wizard resuming at the Review step.
    setupComplete: false,
    resumeStep: 5,
    users: [{ email: 'admin@riverside.demo', fullName: 'Meera Iyer', role: 'SCHOOL_ADMIN' }],
    school: {
      schoolCode: 'RVA',
      legalName: 'Riverside Academy Trust',
      displayName: 'Riverside Academy',
      primaryEmail: 'hello@riverside.demo',
      primaryPhone: '+91 98450 22000',
    },
    locations: [
      {
        displayName: 'Bengaluru Campus',
        locationCode: 'MOH', // same code as Greenfield on purpose: codes are unique per school, not globally
        locationType: 'MAIN_CAMPUS',
        intent: 'ACTIVE',
        phone: '+91 98450 22001',
        address: { line1: '14 Lake View Road', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001', country: 'IN' },
      },
    ],
  },
];

async function wipeTenant(tenantId: string) {
  // Audit events are append-only through Mongoose, so remove demo rows via the raw collection.
  await AuditEvent.collection.deleteMany({ tenantId });
  await Promise.all([
    School.deleteMany({ tenantId }),
    SchoolIdentifier.deleteMany({ tenantId }),
    Location.deleteMany({ tenantId }),
    LocationReference.deleteMany({ tenantId }),
    User.deleteMany({ tenantId }),
    Session.deleteMany({ tenantId }),
    UserLocationAccess.deleteMany({ tenantId }),
    // Academic structure (Module 2)
    AcademicSession.deleteMany({ tenantId }),
    AcademicTerm.deleteMany({ tenantId }),
    GradeOffering.deleteMany({ tenantId }),
    SectionOffering.deleteMany({ tenantId }),
    SubjectOffering.deleteMany({ tenantId }),
    SubjectChoiceGroup.deleteMany({ tenantId }),
    SubjectChoiceConstraint.deleteMany({ tenantId }),
    AcademicProgramme.deleteMany({ tenantId }),
    Subject.deleteMany({ tenantId }),
    BoardSubjectDefinition.deleteMany({ tenantId }),
    EducationBoard.deleteMany({ tenantId }),
    BoardRuleVersion.deleteMany({ tenantId }),
  ]);
  await Tenant.deleteOne({ _id: tenantId });
}

/** Loads the demo tenants into whatever database is currently connected. */
export async function seedDemo({ quiet = false }: { quiet?: boolean } = {}) {
  const log = quiet ? () => undefined : console.log;
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  await seedReferenceData(); // system boards, rule versions and the grade master

  for (const def of DEMO_TENANTS) {
    const previous = await Tenant.findOne({ slug: def.slug }).lean();
    if (previous) await wipeTenant(previous._id);

    const tenantId = randomUUID();
    const adminId = randomUUID();
    await Tenant.create({ _id: tenantId, name: def.name, slug: def.slug, createdBy: adminId });
    for (const u of def.users) {
      const id = u.role === 'SCHOOL_ADMIN' ? adminId : randomUUID();
      await User.create({ _id: id, tenantId, ...u, passwordHash, createdBy: adminId, updatedBy: adminId });
    }

    // Go through the domain services so seeded data follows every rule and has an audit trail.
    const ctx: ServiceContext = {
      tenantId,
      userId: adminId,
      role: 'SCHOOL_ADMIN',
      permissions: permissionsFor('SCHOOL_ADMIN'),
      requestId: null,
    };
    const school = await createSchool(ctx, createSchoolSchema.parse(def.school));
    for (const identifier of def.identifiers ?? []) await createIdentifier(ctx, school._id, createIdentifierSchema.parse(identifier));
    const created: Awaited<ReturnType<typeof createLocation>>[] = [];
    for (const loc of def.locations) created.push(await createLocation(ctx, school._id, createLocationSchema.parse(loc)));
    if (def.setupComplete) {
      await completeSetup(ctx, school._id);
      await seedStarterSubjects(ctx);
      const byCode = (code: string) => created.find((l) => l.locationCode === code)!._id;
      if (def.slug === 'greenfield-public-school') {
        await seedAcademicDemo(ctx, { mohaliId: byCode('MOH'), chandigarhId: byCode('CHD') });
        log('    📚 Academic session 2026-27 (active) and 2027-28 (draft, cloned)');
      }
    }
    else if (def.resumeStep) await saveSetupProgress(ctx, school._id, def.resumeStep);

    log(`✔ ${def.name} — setup ${def.setupComplete ? 'completed' : `in progress (step ${def.resumeStep ?? 1})`}`);
    for (const u of def.users) log(`    ${u.role.padEnd(13)} ${u.email}`);
    for (const l of created) {
      log(`    📍 ${l.locationCode.padEnd(4)} ${l.displayName} — ${l.status}${l.isPrimary ? ' · Primary' : ''}`);
    }
  }

  log(`\nAll demo accounts use the password: ${DEMO_PASSWORD}\n`);
}

async function main() {
  await connectDatabase(env.MONGODB_URI);
  await seedDemo();
  await disconnectDatabase();
}

// Run only when executed directly (`npm run seed`), not when imported by the e2e server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error('Seed failed:', err);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
}
