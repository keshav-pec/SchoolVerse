import { hasPermission, ROLES, type Permission } from '@shared';
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from './helpers/db';
import { createUserAndLogin, signupAdmin } from './helpers/factories';

describe('RBAC matrix (PRD §7)', () => {
  const adminOnly: Permission[] = [
    'school:edit',
    'school:view_config',
    'location:view_config',
    'location:create',
    'location:edit',
    'location:set_primary',
    'location:change_status',
    'location:archive',
    'setup:manage',
    'audit:view',
  ];

  it('School Admin has every permission', () => {
    for (const p of adminOnly) expect(hasPermission('SCHOOL_ADMIN', p)).toBe(true);
  });

  it('Faculty and Staff get a limited, read-only view', () => {
    for (const role of ['FACULTY', 'STAFF'] as const) {
      expect(hasPermission(role, 'school:view')).toBe(true);
      expect(hasPermission(role, 'location:view')).toBe(true);
      for (const p of adminOnly) expect(hasPermission(role, p)).toBe(false);
    }
  });

  it('Parents have no access to school configuration', () => {
    expect(hasPermission('PARENT', 'school:view')).toBe(false);
    expect(hasPermission('PARENT', 'location:view')).toBe(false);
  });

  it('defines exactly the four baseline roles', () => {
    expect([...ROLES]).toEqual(['SCHOOL_ADMIN', 'FACULTY', 'STAFF', 'PARENT']);
  });
});

describe('server-side enforcement & tenant isolation (SCH-LOC-09, SCH-LOC-15)', () => {
  useTestDatabase();

  it('non-admin roles are rejected by the server even when calling the API directly', async () => {
    const { session } = await signupAdmin();
    for (const role of ['FACULTY', 'STAFF', 'PARENT'] as const) {
      const { agent } = await createUserAndLogin(session.tenant.tenantId, role);
      const res = await agent.get('/api/v1/users').expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('an admin only sees users from their own tenant', async () => {
    const a = await signupAdmin('Tenant A');
    const b = await signupAdmin('Tenant B');
    await createUserAndLogin(a.session.tenant.tenantId, 'FACULTY');

    const listA = await a.agent.get('/api/v1/users').expect(200);
    expect(listA.body.data.total).toBe(2);
    expect(listA.body.data.items.every((u: { tenantId: string }) => u.tenantId === a.session.tenant.tenantId)).toBe(true);

    const listB = await b.agent.get('/api/v1/users').expect(200);
    expect(listB.body.data.total).toBe(1);
  });

  it('manipulating ids to reach another tenant returns 404, not the record', async () => {
    const a = await signupAdmin('Tenant A');
    const b = await signupAdmin('Tenant B');
    const res = await a.agent.get(`/api/v1/users/${b.session.user.userId}`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    await a.agent.get(`/api/v1/users/${a.session.user.userId}`).expect(200);
  });

  it('role changes take effect immediately (role is re-read on every request)', async () => {
    const { session } = await signupAdmin();
    const { agent, userId } = await createUserAndLogin(session.tenant.tenantId, 'FACULTY');
    await agent.get('/api/v1/users').expect(403);
    const { User } = await import('../src/platform/users/user.model');
    await User.updateOne({ _id: userId, tenantId: session.tenant.tenantId }, { role: 'SCHOOL_ADMIN' });
    await agent.get('/api/v1/users').expect(200);
  });
});
