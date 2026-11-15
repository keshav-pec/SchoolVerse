/**
 * Seeds two isolated demo tenants with one user per role.
 * Idempotent: re-running removes the previous demo data for these tenants first.
 *
 *   npm run seed
 */
import { randomUUID } from 'node:crypto';
import type { Role } from '@shared';
import { env } from '../config/env';
import { connectDatabase, disconnectDatabase } from '../db/connection';
import { AuditEvent } from '../modules/audit/audit.model';
import { hashPassword } from '../platform/auth/password';
import { Session } from '../platform/auth/session.model';
import { UserLocationAccess } from '../platform/rbac/user-location-access.model';
import { Tenant } from '../platform/tenants/tenant.model';
import { User } from '../platform/users/user.model';

export const DEMO_PASSWORD = 'Welcome@123';

const DEMO_TENANTS: { slug: string; name: string; users: { email: string; fullName: string; role: Role }[] }[] = [
  {
    slug: 'greenfield-public-school',
    name: 'Greenfield Public School',
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
    users: [{ email: 'admin@riverside.demo', fullName: 'Meera Iyer', role: 'SCHOOL_ADMIN' }],
  },
];

async function wipeTenant(tenantId: string) {
  // Audit events are append-only through Mongoose, so remove demo rows via the raw collection.
  await AuditEvent.collection.deleteMany({ tenantId });
  await Promise.all([
    User.deleteMany({ tenantId }),
    Session.deleteMany({ tenantId }),
    UserLocationAccess.deleteMany({ tenantId }),
  ]);
  await Tenant.deleteOne({ _id: tenantId });
}

async function main() {
  await connectDatabase(env.MONGODB_URI);
  const passwordHash = await hashPassword(DEMO_PASSWORD);

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
    console.log(`✔ ${def.name}`);
    for (const u of def.users) console.log(`    ${u.role.padEnd(13)} ${u.email}`);
  }

  console.log(`\nAll demo accounts use the password: ${DEMO_PASSWORD}\n`);
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
