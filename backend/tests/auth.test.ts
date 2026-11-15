import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { useTestDatabase } from './helpers/db';
import { app, PASSWORD, signupAdmin, uniqueEmail } from './helpers/factories';

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

describe('auth (platform foundation)', () => {
  useTestDatabase();
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
