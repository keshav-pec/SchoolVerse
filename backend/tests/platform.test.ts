import { randomUUID } from 'node:crypto';
import mongoose, { Schema } from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SKIP_TENANT_SCOPE, tenantScopePlugin } from '../src/db/plugins/tenant-scope';
import { buildOpenApiDocument, listEndpoints } from '../src/docs/openapi';
import { apiRouter } from '../src/routes';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { User } from '../src/platform/users/user.model';
import {
  API, app, createUserAndLogin, PASSWORD, signupAdmin, uniqueEmail, useTestDatabase,
  activatedLogin, addActiveEmployee, expectError, outboxLink, provisionLogin, serviceContextFor,
  staffSchool, stepUp, today, tokenFromLink, linkUser,
} from './helpers';
import type { UserDTO } from '@shared';
import { AccountToken } from '../src/platform/identity/account-token.model';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { employeeService } from '../src/modules/staff/employee-contract';
import { processDueExits } from '../src/modules/staff/jobs';
import { addDays } from '../src/core/dates';
import { Session } from '../src/platform/auth/session.model';
import { suspendUser } from '../src/platform/identity/user-admin.service';
import { hashToken } from '../src/platform/auth/tokens';

useTestDatabase();

function cookieNames(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((c) => c.split('=')[0]!);
}

function cookieOf(res: request.Response, name: string): string {
  const raw = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const found = raw.find((c) => c.startsWith(`${name}=`));
  if (!found) throw new Error(`cookie ${name} not set`);
  return found.split(';')[0]!;
}
const refreshCookieOf = (res: request.Response) => cookieOf(res, 'sv_refresh');

describe('auth', () => {
  afterEach(() => vi.restoreAllMocks());

  it('signup creates a tenant + School Admin, sets httpOnly cookies and records audit events', async () => {
    const agent = request.agent(app);
    const email = uniqueEmail();
    const res = await agent
      .post('/api/v1/auth/signup')
      .send({ workspaceName: 'Greenfield Public School', fullName: 'Aarav Mehta', email: email.toUpperCase(), password: PASSWORD })
      .expect(201);

    expect(res.body.data.user).toMatchObject({ email, role: 'SCHOOL_ADMIN', status: 'ACTIVE' });
    expect(res.body.data.user.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.data.tenant.name).toBe('Greenfield Public School');
    expect(res.body.data.permissions).toContain('school:edit');
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    expect(cookieNames(res)).toEqual(expect.arrayContaining(['sv_access', 'sv_refresh']));
    expect((res.headers['set-cookie'] as unknown as string[]).every((c) => c.includes('HttpOnly'))).toBe(true);

    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.data.user.email).toBe(email);

    const tenantId = res.body.data.tenant.tenantId;
    const actions = (await AuditEvent.find({ tenantId }).lean()).map((e) => e.action).sort();
    expect(actions).toEqual(['tenant.created', 'user.created']);
  });

  it('rejects a duplicate email with EMAIL_TAKEN', async () => {
    const { email } = await signupAdmin();
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ workspaceName: 'Another', fullName: 'X', email, password: PASSWORD })
      .expect(409);
    expect(res.body.error).toMatchObject({ code: 'EMAIL_TAKEN', details: { fields: { email: expect.any(String) } } });
  });

  it('returns field-level VALIDATION_FAILED errors with a requestId', async () => {
    const res = await request(app).post('/api/v1/auth/signup').send({ email: 'nope', password: 'short' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.details.fields)).toEqual(expect.arrayContaining(['workspaceName', 'fullName', 'email', 'password']));
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('login succeeds with correct credentials and fails generically otherwise', async () => {
    const { email } = await signupAdmin();
    await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);

    const wrong = await request(app).post('/api/v1/auth/login').send({ email, password: 'Wrong12345' }).expect(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await request(app).post('/api/v1/auth/login').send({ email: 'ghost@example.com', password: PASSWORD }).expect(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('protected routes require authentication', async () => {
    const res = await request(app).get('/api/v1/auth/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('refresh rotates the refresh token; a replay inside the grace window is rejected without killing the family', async () => {
    const { email } = await signupAdmin();
    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const oldCookie = refreshCookieOf(loginRes);

    const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', oldCookie).expect(200);
    const newCookie = refreshCookieOf(rotated);
    expect(newCookie).not.toBe(oldCookie);

    // Within the grace window a replay is rejected but the family survives (multi-tab race), and the losing tab's
    // response leaves the cookies alone, so it cannot wipe the ones the winning tab was just given.
    const raced = await request(app).post('/api/v1/auth/refresh').set('Cookie', oldCookie).expect(401);
    expect(raced.headers['set-cookie']).toBeUndefined();
    await request(app).post('/api/v1/auth/refresh').set('Cookie', newCookie).expect(200);
  });

  it('a replayed token outside the grace window revokes the whole session family', async () => {
    const { email } = await signupAdmin();
    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const oldCookie = refreshCookieOf(loginRes);
    const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', oldCookie).expect(200);
    const newCookie = refreshCookieOf(rotated);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', oldCookie).expect(401);
    vi.restoreAllMocks();
    // Theft, not a race: the cookies are cleared.
    expect(replay.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringMatching(/^sv_refresh=;/)]));

    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', newCookie).expect(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('logout revokes the session immediately', async () => {
    const { agent, email } = await signupAdmin();
    const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const access = cookieOf(res, 'sv_access');
    await agent.post('/api/v1/auth/logout').expect(204);
    // Even a still-unexpired access token stops working once its session is revoked.
    await request(app).get('/api/v1/auth/me').set('Cookie', access).expect(401);
  });

  it('health endpoint responds', async () => {
    const res = await request(app).get('/api/v1/health').expect(200);
    expect(res.body.data).toMatchObject({ status: 'ok', db: 'connected' });
  });

  it('unknown routes return ROUTE_NOT_FOUND', async () => {
    const res = await request(app).get('/api/v1/nope').expect(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('users: server-side enforcement & tenant isolation (SCH-LOC-09, SCH-LOC-15)', () => {
  it('non-admin roles are rejected by the server even when calling the API directly', async () => {
    const { session } = await signupAdmin();
    for (const role of ['FACULTY', 'STAFF', 'PARENT'] as const) {
      const { agent } = await createUserAndLogin(session.tenant.tenantId, role);
      const res = await agent.get(`${API}/users`).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('an admin only sees their own tenant, and other tenants’ ids are 404', async () => {
    const a = await signupAdmin('Tenant A');
    const b = await signupAdmin('Tenant B');
    await createUserAndLogin(a.session.tenant.tenantId, 'FACULTY');

    const listA = await a.agent.get(`${API}/users`).expect(200);
    expect(listA.body.data.total).toBe(2);
    expect(listA.body.data.items.every((u: { tenantId: string }) => u.tenantId === a.session.tenant.tenantId)).toBe(true);
    expect((await b.agent.get(`${API}/users`).expect(200)).body.data.total).toBe(1);

    const res = await a.agent.get(`${API}/users/${b.session.user.userId}`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    await a.agent.get(`${API}/users/${a.session.user.userId}`).expect(200);
  });

  it('role changes take effect immediately (role is re-read on every request)', async () => {
    const { session } = await signupAdmin();
    const { agent, userId } = await createUserAndLogin(session.tenant.tenantId, 'FACULTY');
    await agent.get(`${API}/users`).expect(403);
    await User.updateOne({ _id: userId, tenantId: session.tenant.tenantId }, { role: 'SCHOOL_ADMIN' });
    await agent.get(`${API}/users`).expect(200);
  });
});

describe('tenantScopePlugin (SCH-LOC-15)', () => {
  const widgetSchema = new Schema({ _id: { type: String, default: () => randomUUID() }, tenantId: String, name: String });
  widgetSchema.plugin(tenantScopePlugin);
  const Widget = mongoose.model('ScopeTestWidget', widgetSchema);

  it('rejects queries, aggregations and inserts without a tenantId', async () => {
    await expect(Widget.find({})).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
    await expect(Widget.findById(randomUUID())).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
    await expect(Widget.countDocuments({ name: 'x' })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
    await expect(Widget.updateMany({}, { name: 'y' })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
    await expect(Widget.deleteOne({ name: 'x' })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
    await expect(Widget.aggregate([{ $match: { name: 'x' } }])).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
    await expect(Widget.create({ name: 'orphan' })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
  });

  it('returns only the requesting tenant’s rows, with explicit system lookups as the escape hatch', async () => {
    await Widget.create([
      { tenantId: 'tenant-a', name: 'A1' },
      { tenantId: 'tenant-a', name: 'A2' },
      { tenantId: 'tenant-b', name: 'B1' },
    ]);
    expect((await Widget.find({ tenantId: 'tenant-a' }).lean()).map((r) => r.name).sort()).toEqual(['A1', 'A2']);
    await expect(Widget.aggregate([{ $match: { tenantId: 'tenant-b' } }])).resolves.toHaveLength(1);
    expect(await Widget.countDocuments({}).setOptions(SKIP_TENANT_SCOPE)).toBe(3);
  });
});

describe('API documentation (SCH-LOC-14)', () => {
  it('the OpenAPI spec is generated from every route, with auth, permissions and request schemas', () => {
    type Operation = { security: unknown; description?: string; parameters: { name: string }[]; requestBody: { content: Record<string, { schema: { properties: object } }> } };
    const spec = buildOpenApiDocument(apiRouter) as unknown as { paths: Record<string, Record<string, Operation>>; components: Record<string, Record<string, unknown>> };
    const endpoints = listEndpoints(apiRouter);
    expect(endpoints.length).toBeGreaterThan(150);
    for (const e of endpoints) expect(spec.paths[e.path.replace(/:(\w+)/g, '{$1}')]?.[e.method], `${e.method} ${e.path}`).toBeDefined();

    const op = (path: string, method: string) => spec.paths[path]![method]!;
    expect(op('/health', 'get').security).toEqual([]);
    const createLocation = op('/schools/{schoolId}/locations', 'post');
    expect(createLocation.security).toEqual([{ cookieAuth: [] }]);
    expect(createLocation.description).toContain('location:create');
    expect(createLocation.requestBody.content['application/json']!.schema.properties).toHaveProperty('locationCode');
    expect(op('/academic-sessions/{academicSessionId}/publish', 'post').description).toContain('academic:publish');
    expect(op('/employees', 'get').parameters.map((p) => p.name)).toContain('q');

    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
    for (const [, kind, name] of refs) expect(spec.components[kind!]?.[name!], `#/components/${kind}/${name}`).toBeDefined();
  });

  it('serves Swagger UI and the raw spec without auth, keeping the strict CSP on the API itself', async () => {
    const ui = await request(app).get('/api/docs/').expect(200);
    expect(ui.text).toContain('swagger-ui');
    expect(ui.headers['content-security-policy']).toBeUndefined();
    expect((await request(app).get('/api/docs.json').expect(200)).body.info.title).toMatch(/SchoolVerse/);
    const health = await request(app).get(`${API}/health`).expect(200);
    expect(health.headers['content-security-policy']).toContain("default-src 'self'");
  });
});

const post = (path: string, body: object = {}) => request(app).post(`${API}${path}`).send(body);

describe('accounts: provisioning and activation (IAM-01)', () => {
  it('QA F5: a login is created independently of the employee, and a pending user cannot sign in', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t, { officialEmail: 'priya@greenfield.demo' });

    // The employee exists with no login at all.
    const before = (await t.agent.get(`${API}/employees/${employee.employeeId}/user-account`).expect(200)).body.data;
    expect(before).toEqual({ account: null, defaultEmail: 'priya@greenfield.demo' });

    // The admin picks the role and never a password; the email defaults to the official one.
    const res = await t.agent.post(`${API}/employees/${employee.employeeId}/user-account`).send({ role: 'FACULTY' }).expect(201);
    expect(res.body.data).toMatchObject({ email: 'priya@greenfield.demo', role: 'FACULTY', status: 'PENDING_ACTIVATION', personId: employee.personId });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|token/i);

    // No password exists yet, so signing in fails exactly like a wrong password.
    expectError(await post('/auth/login', { email: 'priya@greenfield.demo', password: PASSWORD }), 401, 'INVALID_CREDENTIALS');
    expect((await User.findOne({ email: 'priya@greenfield.demo' }).select('+passwordHash').setOptions(SKIP_TENANT_SCOPE).lean())?.passwordHash).toBeNull();

    // The role comes from the admin's choice, not the designation.
    const principal = await addActiveEmployee(t, { officialEmail: 'principal@greenfield.demo' });
    const staffLogin = await t.agent.post(`${API}/employees/${principal.employeeId}/user-account`).send({ role: 'STAFF' }).expect(201);
    expect(staffLogin.body.data.role).toBe('STAFF');
  });

  it('the account route needs a role, refuses unknown keys, a second login and an email that is already taken', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t, { officialEmail: 'a@greenfield.demo' });
    const url = `${API}/employees/${employee.employeeId}/user-account`;

    expectError(await t.agent.post(url).send({}), 400, 'VALIDATION_FAILED');
    expectError(await t.agent.post(url).send({ role: 'PARENT' }), 400, 'VALIDATION_FAILED');
    expectError(await t.agent.post(url).send({ role: 'FACULTY', status: 'ACTIVE', password: 'x' }), 400, 'VALIDATION_FAILED');

    await t.agent.post(url).send({ role: 'FACULTY' }).expect(201);
    expectError(await t.agent.post(url).send({ role: 'FACULTY' }), 409, 'ACCOUNT_EXISTS');

    const other = await addActiveEmployee(t, { officialEmail: 'a@greenfield.demo' });
    expectError(await t.agent.post(`${API}/employees/${other.employeeId}/user-account`).send({ role: 'FACULTY' }), 409, 'EMAIL_TAKEN');

    // An employee with no email anywhere needs one to be given.
    const none = await addActiveEmployee(t);
    expectError(await t.agent.post(`${API}/employees/${none.employeeId}/user-account`).send({ role: 'FACULTY' }), 400, 'VALIDATION_FAILED');
  });

  it('QA F5: the person follows the link, chooses a password and signs in as themselves, with their own profile only', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t, { legalFirstName: 'Priya' });
    const { email, token } = await provisionLogin(t, employee);

    // The check greets by first name and shows nothing else.
    const check = await request(app).get(`${API}/auth/activation/${token}`).expect(200);
    expect(check.body.data).toEqual({ firstName: 'Priya' });

    expectError(await post('/auth/activate', { token, password: 'short' }), 400, 'VALIDATION_FAILED');
    await post('/auth/activate', { token, password: PASSWORD }).expect(200);

    const agent = request.agent(app);
    const login = await agent.post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(200);
    expect(login.body.data.user).toMatchObject({ status: 'ACTIVE', personId: employee.personId, role: 'FACULTY' });
    expect(login.body.data.permissions).toEqual(expect.arrayContaining(['employee:directory']));

    const me = (await agent.get(`${API}/me/profile`).expect(200)).body.data;
    expect(me.profile.employeeId).toBe(employee.employeeId);
    // Faculty reach no admin screens.
    expectError(await agent.get(`${API}/profile-change-requests`), 403, 'FORBIDDEN');
    expectError(await agent.get(`${API}/employees/${employee.employeeId}/restricted`), 403, 'FORBIDDEN');
  });

  it('QA S9: an activation link works once; unknown, used, expired and re-sent tokens all fail with the same error', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t, { officialEmail: 'once@greenfield.demo' });
    const { user, token } = await provisionLogin(t, employee, { email: 'once@greenfield.demo' });

    // Re-sending voids the first link.
    await t.agent.post(`${API}/users/${user.userId}/resend-activation`).expect(200);
    const second = tokenFromLink(await outboxLink('once@greenfield.demo', 'ACTIVATION'));
    expect(second).not.toBe(token);
    const stale = await post('/auth/activate', { token, password: PASSWORD });
    const unknown = await post('/auth/activate', { token: 'x'.repeat(64), password: PASSWORD });
    expectError(stale, 400, 'TOKEN_INVALID');
    expectError(unknown, 400, 'TOKEN_INVALID');
    expect(stale.body.error.message).toBe(unknown.body.error.message);
    expectError(await request(app).get(`${API}/auth/activation/${token}`), 400, 'TOKEN_INVALID');

    // Expired.
    await AccountToken.updateOne({ tenantId: t.tenantId, tokenHash: hashToken(second) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expectError(await post('/auth/activate', { token: second, password: PASSWORD }), 400, 'TOKEN_INVALID');

    // Used: a fresh link works once and then never again.
    await t.agent.post(`${API}/users/${user.userId}/resend-activation`).expect(200);
    const third = tokenFromLink(await outboxLink('once@greenfield.demo', 'ACTIVATION'));
    await post('/auth/activate', { token: third, password: PASSWORD }).expect(200);
    expectError(await post('/auth/activate', { token: third, password: 'Another123' }), 400, 'TOKEN_INVALID');
    expectError(await request(app).get(`${API}/auth/activation/${third}`), 400, 'TOKEN_INVALID');

    // An active account has nothing left to resend.
    expectError(await t.agent.post(`${API}/users/${user.userId}/resend-activation`), 409, 'INVALID_STATUS_TRANSITION');
  });
});

describe('forgot and reset password (IAM-03)', () => {
  it('QA S9: forgot-password answers 202 with one body for every email, and only an active account gets a link', async () => {
    const t = await staffSchool();
    const active = await activatedLogin(t, await addActiveEmployee(t), { email: 'active@greenfield.demo' });
    const { email: pending } = await provisionLogin(t, await addActiveEmployee(t), { email: 'pending@greenfield.demo' });

    const answers = [];
    for (const email of ['active@greenfield.demo', pending, 'nobody@greenfield.demo']) answers.push(await post('/auth/forgot-password', { email }).expect(202));
    expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);

    await outboxLink('active@greenfield.demo', 'PASSWORD_RESET');
    const none = await request(app).get(`${API}/dev/outbox`).query({ to: 'nobody@greenfield.demo' }).expect(200);
    expect(none.body.data.items).toEqual([]);
    const pendingMail = (await request(app).get(`${API}/dev/outbox`).query({ to: pending }).expect(200)).body.data.items as { template: string }[];
    expect(pendingMail.map((m) => m.template)).toEqual(['ACTIVATION']);

    // Suspended accounts get nothing either.
    await t.agent.post(`${API}/users/${active.userId}/suspend`).send({ reason: 'Investigation' }).expect(200);
    await post('/auth/forgot-password', { email: 'active@greenfield.demo' }).expect(202);
    const mails = (await request(app).get(`${API}/dev/outbox`).query({ to: 'active@greenfield.demo' }).expect(200)).body.data.items as { template: string }[];
    expect(mails.filter((m) => m.template === 'PASSWORD_RESET')).toHaveLength(1);
  });

  it('QA S9: a reset link sets the password once, ends every session, and expires', async () => {
    const t = await staffSchool();
    const person = await activatedLogin(t, await addActiveEmployee(t), { email: 'reset@greenfield.demo' });
    const second = request.agent(app);
    await second.post(`${API}/auth/login`).send({ email: 'reset@greenfield.demo', password: PASSWORD }).expect(200);
    await person.agent.get(`${API}/auth/me`).expect(200);

    await post('/auth/forgot-password', { email: 'reset@greenfield.demo' }).expect(202);
    const token = tokenFromLink(await outboxLink('reset@greenfield.demo', 'PASSWORD_RESET'));
    await post('/auth/reset-password', { token, password: 'BrandNew123' }).expect(200);

    // Both live sessions are gone; the old password no longer works; the new one does.
    expectError(await person.agent.get(`${API}/auth/me`), 401, 'SESSION_EXPIRED');
    expectError(await second.get(`${API}/auth/me`), 401, 'SESSION_EXPIRED');
    expectError(await post('/auth/login', { email: 'reset@greenfield.demo', password: PASSWORD }), 401, 'INVALID_CREDENTIALS');
    await post('/auth/login', { email: 'reset@greenfield.demo', password: 'BrandNew123' }).expect(200);

    // Single use, and a reset token is not an activation token.
    expectError(await post('/auth/reset-password', { token, password: 'Another123' }), 400, 'TOKEN_INVALID');
    expectError(await post('/auth/activate', { token, password: 'Another123' }), 400, 'TOKEN_INVALID');

    // Expiry (30 minutes).
    await post('/auth/forgot-password', { email: 'reset@greenfield.demo' }).expect(202);
    const late = tokenFromLink(await outboxLink('reset@greenfield.demo', 'PASSWORD_RESET'));
    await AccountToken.updateOne({ tenantId: t.tenantId, tokenHash: hashToken(late) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expectError(await post('/auth/reset-password', { token: late, password: 'Another123' }), 400, 'TOKEN_INVALID');
  });
});

describe('suspension, disabling and roles (IAM-03)', () => {
  it('QA S8: suspending revokes live sessions, so the very next request fails; reactivating allows a new sign-in', async () => {
    const t = await staffSchool();
    const person = await activatedLogin(t, await addActiveEmployee(t), { email: 'susp@greenfield.demo' });
    await person.agent.get(`${API}/employees`).expect(200);

    const suspended = (await t.agent.post(`${API}/users/${person.userId}/suspend`).send({ reason: 'Under review' }).expect(200)).body.data as UserDTO;
    expect(suspended.status).toBe('SUSPENDED');
    expectError(await person.agent.get(`${API}/employees`), 401, 'SESSION_EXPIRED');
    expect(await Session.countDocuments({ tenantId: t.tenantId, userId: person.userId, revokedAt: null })).toBe(0);
    expectError(await post('/auth/login', { email: 'susp@greenfield.demo', password: PASSWORD }), 403, 'ACCOUNT_SUSPENDED');

    await t.agent.post(`${API}/users/${person.userId}/reactivate`).expect(200);
    await post('/auth/login', { email: 'susp@greenfield.demo', password: PASSWORD }).expect(200);

    // The reason is on the audit row, with the change; nothing else about the person.
    const row = await AuditEvent.findOne({ tenantId: t.tenantId, action: 'user.suspended' }).lean();
    expect(row).toMatchObject({ entityId: person.userId, changes: [{ field: 'status', from: 'ACTIVE', to: 'SUSPENDED' }], metadata: { reason: 'Under review' } });
  });

  it('disabling ends access for good; the suspend and disable routes need a reason and user:manage', async () => {
    const t = await staffSchool();
    const person = await activatedLogin(t, await addActiveEmployee(t), { email: 'dis@greenfield.demo' });
    expectError(await t.agent.post(`${API}/users/${person.userId}/suspend`).send({}), 400, 'VALIDATION_FAILED');

    // Faculty cannot use any of these routes on anyone.
    const other = await createUserAndLogin(t.tenantId, 'FACULTY');
    for (const [method, path] of [['post', 'suspend'], ['post', 'reactivate'], ['post', 'disable'], ['patch', 'role'], ['post', 'resend-activation']] as const) {
      const res = await other.agent[method](`${API}/users/${person.userId}/${path}`).send({ reason: 'x', role: 'STAFF' });
      expectError(res, 403, 'FORBIDDEN');
    }

    await t.agent.post(`${API}/users/${person.userId}/disable`).expect(200);
    expectError(await person.agent.get(`${API}/auth/me`), 401, 'SESSION_EXPIRED');
    expectError(await post('/auth/login', { email: 'dis@greenfield.demo', password: PASSWORD }), 403, 'ACCOUNT_DISABLED');
    expectError(await t.agent.post(`${API}/users/${person.userId}/reactivate`), 409, 'INVALID_STATUS_TRANSITION');
  });

  it('a role change takes effect at once, ends the sessions, and leaves an audit row and a ROLE_CHANGED security event', async () => {
    const t = await staffSchool();
    const person = await activatedLogin(t, await addActiveEmployee(t), { email: 'role@greenfield.demo' });
    expectError(await person.agent.get(`${API}/users`), 403, 'FORBIDDEN');

    const changed = (await t.agent.patch(`${API}/users/${person.userId}/role`).send({ role: 'SCHOOL_ADMIN' }).expect(200)).body.data as UserDTO;
    expect(changed.role).toBe('SCHOOL_ADMIN');
    expectError(await person.agent.get(`${API}/users`), 401, 'SESSION_EXPIRED');

    await post('/auth/login', { email: 'role@greenfield.demo', password: PASSWORD }).expect(200);
    expect(await AuditEvent.findOne({ tenantId: t.tenantId, action: 'user.role_changed' }).lean()).toMatchObject({ changes: [{ field: 'role', from: 'FACULTY', to: 'SCHOOL_ADMIN' }] });
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'ROLE_CHANGED', targetId: person.userId })).toBe(1);
    expectError(await t.agent.patch(`${API}/users/${person.userId}/role`).send({ role: 'PARENT' }), 400, 'VALIDATION_FAILED');
  });

  it('an admin cannot act on their own account, and the last active School Admin cannot be suspended, disabled or demoted', async () => {
    const t = await staffSchool();
    const adminId = t.ctx.userId;
    expectError(await t.agent.post(`${API}/users/${adminId}/suspend`).send({ reason: 'x' }), 409, 'CANNOT_ACT_ON_SELF');
    expectError(await t.agent.post(`${API}/users/${adminId}/disable`), 409, 'CANNOT_ACT_ON_SELF');
    expectError(await t.agent.patch(`${API}/users/${adminId}/role`).send({ role: 'FACULTY' }), 409, 'CANNOT_ACT_ON_SELF');

    // A second admin can act on the first only while someone else is still an admin; the guard counts the others.
    const second = await activatedLogin(t, await addActiveEmployee(t), { email: 'second@greenfield.demo', role: 'SCHOOL_ADMIN' });
    await second.agent.post(`${API}/users/${adminId}/suspend`).send({ reason: 'x' }).expect(200);
    // Now `second` is the only active admin. Another actor (here: a service call) cannot remove them.
    const stranger = serviceContextFor(t.tenantId, '00000000-0000-4000-8000-000000000001');
    await expect(suspendUser(stranger, second.userId, { reason: 'x' })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    expect((await User.findOne({ _id: second.userId, tenantId: t.tenantId }).lean())?.status).toBe('ACTIVE');
  });
});

describe('offboarding closes access (IAM-03, FSM-01)', () => {
  it('QA F8: exiting today disables the login and kills its sessions in the same step; the role stays on record', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const person = await activatedLogin(t, employee, { email: 'leaver@greenfield.demo' });
    await person.agent.get(`${API}/me/profile`).expect(200);

    await t.agent.post(`${API}/employees/${employee.employeeId}/exit`).send({ exitDate: today(), exitReasonCategory: 'RESIGNATION' }).expect(200);

    // The next request is signed out; the account is DISABLED with its role kept for history.
    expectError(await person.agent.get(`${API}/me/profile`), 401, 'SESSION_EXPIRED');
    expectError(await post('/auth/login', { email: 'leaver@greenfield.demo', password: PASSWORD }), 403, 'ACCOUNT_DISABLED');
    expect(await User.findOne({ _id: person.userId, tenantId: t.tenantId }).lean()).toMatchObject({ status: 'DISABLED', role: 'FACULTY' });

    // The account change is on the employee's own timeline.
    const history = (await t.agent.get(`${API}/employees/${employee.employeeId}/history`).expect(200)).body.data.events as { action: string }[];
    expect(history.map((e) => e.action)).toEqual(expect.arrayContaining(['user.account_created', 'user.disabled', 'employee.exited']));
  });

  it('QA F8: a future exit keeps the login working during the notice period, and the job disables it on the exit date', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const person = await activatedLogin(t, employee, { email: 'notice@greenfield.demo' });
    const exitDate = addDays(today(), 10);

    await t.agent.post(`${API}/employees/${employee.employeeId}/exit`).send({ exitDate, exitReasonCategory: 'RETIREMENT' }).expect(200);
    await person.agent.get(`${API}/me/profile`).expect(200);

    expect(await processDueExits(new Date(Date.now() + 11 * 24 * 60 * 60 * 1000))).toBe(1);
    expectError(await person.agent.get(`${API}/me/profile`), 401, 'SESSION_EXPIRED');
    expect((await User.findOne({ _id: person.userId, tenantId: t.tenantId }).lean())?.status).toBe('DISABLED');
    // The scheduled job acts as SYSTEM.
    expect(await AuditEvent.findOne({ tenantId: t.tenantId, action: 'user.disabled' }).lean()).toMatchObject({ actorRole: 'SYSTEM', actorId: null });
  });

  it('an exit that would leave the school with no active School Admin is refused and changes nothing', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    await linkUser(t.tenantId, t.ctx.userId, employee.personId);

    const res = await t.agent.post(`${API}/employees/${employee.employeeId}/exit`).send({ exitDate: today(), exitReasonCategory: 'OTHER' });
    expectError(res, 409, 'LAST_ADMIN');
    expect((await employeeService.getEmployeeSummary(serviceContextFor(t.tenantId, t.ctx.userId), employee.employeeId)).status).toBe('ACTIVE');
    await t.agent.get(`${API}/auth/me`).expect(200);
  });

  it('a rehired person gets their old login back as a new pending account with a new role', async () => {
    const t = await staffSchool();
    const first = await addActiveEmployee(t, { officialEmail: 'back@greenfield.demo' });
    const person = await activatedLogin(t, first, { email: 'back@greenfield.demo' });
    await t.agent.post(`${API}/employees/${first.employeeId}/exit`).send({ exitDate: today(), exitReasonCategory: 'RESIGNATION' }).expect(200);

    // The exited employee cannot be given a login; the new employment can, and it reuses the same user row.
    expectError(await t.agent.post(`${API}/employees/${first.employeeId}/user-account`).send({ role: 'STAFF' }), 409, 'EMPLOYEE_READ_ONLY');
    const rehire = await t.agent.post(`${API}/employees`).send({ personId: first.personId, employeeCode: 'FAC-REHIRE', employeeCategory: 'FACULTY', joiningDate: today(), primaryLocationId: t.moh.locationId, departmentId: t.dept, designationId: t.desig, officialEmail: 'back@greenfield.demo' }).expect(201);
    const restored = (await t.agent.post(`${API}/employees/${rehire.body.data.employeeId}/user-account`).send({ role: 'STAFF' }).expect(201)).body.data as UserDTO;
    expect(restored).toMatchObject({ userId: person.userId, status: 'PENDING_ACTIVATION', role: 'STAFF' });
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'user.account_restored' })).toBe(1);
  });
});

describe('step-up and security events (SEC-02)', () => {
  it('step-up needs the right password; restricted routes demand a recent one (STEP_UP_REQUIRED) and it lapses after 5 minutes', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const url = `${API}/employees/${employee.employeeId}/restricted/reveal`;

    expectError(await t.agent.post(url).send({ field: 'DATE_OF_BIRTH' }), 403, 'STEP_UP_REQUIRED');
    expectError(await t.agent.post(`${API}/auth/step-up`).send({ password: 'wrong-password-1' }), 401, 'INVALID_CREDENTIALS');
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'STEP_UP_FAILED' })).toBe(1);
    expectError(await t.agent.post(url).send({ field: 'DATE_OF_BIRTH' }), 403, 'STEP_UP_REQUIRED');

    const ok = (await t.agent.post(`${API}/auth/step-up`).send({ password: PASSWORD }).expect(200)).body.data;
    expect(ok.validForSeconds).toBe(300);
    // Past the window the stamp no longer counts.
    await Session.updateMany({ tenantId: t.tenantId }, { $set: { stepUpAt: new Date(Date.now() - 6 * 60 * 1000) } });
    expectError(await t.agent.post(url).send({ field: 'DATE_OF_BIRTH' }), 403, 'STEP_UP_REQUIRED');
    // Needs a session: an anonymous caller is simply unauthenticated.
    expectError(await post('/auth/step-up', { password: PASSWORD }), 401, 'UNAUTHENTICATED');
  });

  it('a step-up survives the access token being refreshed, so a reveal does not fail halfway', async () => {
    const t = await staffSchool();
    await stepUp(t.agent);
    await t.agent.post(`${API}/auth/refresh`).expect(200);
    const row = await Session.findOne({ tenantId: t.tenantId, userId: t.ctx.userId, revokedAt: null }).lean();
    expect(row?.stepUpAt).toBeTruthy();
  });

  it('failed sign-ins and a replayed refresh token leave security events (no passwords, no emails)', async () => {
    const t = await staffSchool();
    const person = await activatedLogin(t, await addActiveEmployee(t), { email: 'watch@greenfield.demo' });
    expectError(await post('/auth/login', { email: 'watch@greenfield.demo', password: 'wrong-password-1' }), 401, 'INVALID_CREDENTIALS');
    // Unknown emails belong to no tenant, so there is nothing to record against.
    expectError(await post('/auth/login', { email: 'ghost@greenfield.demo', password: 'wrong-password-1' }), 401, 'INVALID_CREDENTIALS');
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'LOGIN_FAILED', actorUserId: person.userId })).toBe(1);

    // Reuse of a rotated refresh token, after the grace window, is treated as theft.
    const login = await request(app).post(`${API}/auth/login`).send({ email: 'watch@greenfield.demo', password: PASSWORD });
    const stolen = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('sv_refresh='))!;
    await request(app).post(`${API}/auth/refresh`).set('Cookie', stolen).expect(200);
    await Session.updateMany({ tenantId: t.tenantId, revokedReason: 'ROTATED' }, { $set: { revokedAt: new Date(Date.now() - 60_000) } });
    expectError(await request(app).post(`${API}/auth/refresh`).set('Cookie', stolen), 401, 'SESSION_EXPIRED');
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'REFRESH_TOKEN_REUSE', actorUserId: person.userId })).toBe(1);

    const events = JSON.stringify(await SecurityEvent.find({ tenantId: t.tenantId }).lean());
    expect(events).not.toContain('watch@greenfield.demo');
    expect(events).not.toContain('wrong-password-1');
  });

  it('the user list and user DTO never include a hash, token or secret', async () => {
    const t = await staffSchool();
    await activatedLogin(t, await addActiveEmployee(t), { email: 'dto@greenfield.demo' });
    await provisionLogin(t, await addActiveEmployee(t));
    const list = JSON.stringify((await t.agent.get(`${API}/users`).expect(200)).body);
    expect(list).not.toMatch(/passwordHash|tokenHash|"token"|secret/i);
    expect(list).toContain('PENDING_ACTIVATION');
    expect(uniqueEmail()).toBeTruthy();
  });
});
