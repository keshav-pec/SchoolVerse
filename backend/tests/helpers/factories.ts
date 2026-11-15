import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Role } from '@shared';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/platform/auth/password';
import { User } from '../../src/platform/users/user.model';

export const app = createApp();
export const PASSWORD = 'Password123';

let counter = 0;
export function uniqueEmail(prefix = 'user') {
  counter += 1;
  return `${prefix}.${counter}.${Date.now()}@example.com`;
}

/** Signs up a new tenant + School Admin and returns a cookie-carrying agent. */
export async function signupAdmin(workspaceName = 'Test School') {
  const agent = request.agent(app);
  const email = uniqueEmail('admin');
  const res = await agent
    .post('/api/v1/auth/signup')
    .send({ workspaceName, fullName: 'Ada Admin', email, password: PASSWORD })
    .expect(201);
  return { agent, email, session: res.body.data as { user: { userId: string; tenantId: string }; tenant: { tenantId: string } } };
}

/** Inserts a user with the given role into an existing tenant and signs them in. */
export async function createUserAndLogin(tenantId: string, role: Role) {
  const email = uniqueEmail(role.toLowerCase());
  const user = await User.create({
    _id: randomUUID(),
    tenantId,
    email,
    fullName: `${role} Person`,
    role,
    passwordHash: await hashPassword(PASSWORD),
  });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  return { agent, email, userId: user._id };
}
