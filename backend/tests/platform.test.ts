import { randomUUID } from 'node:crypto';
import mongoose, { Schema } from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SKIP_TENANT_SCOPE, tenantScopePlugin } from '../src/db/plugins/tenant-scope';
import { loadOpenApiDocument } from '../src/docs/swagger';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { User } from '../src/platform/users/user.model';
import { API, app, createUserAndLogin, PASSWORD, signupAdmin, uniqueEmail, useTestDatabase } from './helpers';

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

    // Within the grace window a replay is rejected but the family survives (multi-tab race).
    await request(app).post('/api/v1/auth/refresh').set('Cookie', oldCookie).expect(401);
    await request(app).post('/api/v1/auth/refresh').set('Cookie', newCookie).expect(200);
  });

  it('a replayed token outside the grace window revokes the whole session family', async () => {
    const { email } = await signupAdmin();
    const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const oldCookie = refreshCookieOf(loginRes);
    const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', oldCookie).expect(200);
    const newCookie = refreshCookieOf(rotated);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    await request(app).post('/api/v1/auth/refresh').set('Cookie', oldCookie).expect(401);
    vi.restoreAllMocks();

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
  it('the OpenAPI spec resolves every $ref', () => {
    const spec = loadOpenApiDocument() as unknown as { components: Record<string, Record<string, unknown>> };
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
    expect(refs.length).toBeGreaterThan(20);
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
