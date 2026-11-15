import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { GradeOffering, SectionOffering, SubjectOffering } from '../src/modules/academic/offering.model';
import { EducationBoard } from '../src/modules/academic/reference.model';
import { AcademicProgramme, SubjectChoiceConstraint, SubjectChoiceGroup } from '../src/modules/academic/rules.model';
import { AcademicSession, AcademicTerm } from '../src/modules/academic/session.model';
import { Subject } from '../src/modules/academic/subject.model';
import { Location } from '../src/modules/locations/location.model';
import { School } from '../src/modules/school/school.model';
import {
  addGrades,
  API,
  app,
  createSession,
  createStarterSubjects,
  createUserAndLogin,
  draftLocationBody,
  expectError,
  loadReference,
  seededSchool,
  setupSchool,
  useTestDatabase,
  validSchool,
  type Agent,
} from './helpers';

useTestDatabase();

type Call = { name: string; send: (agent: Agent) => Promise<{ status: number; body: { error?: { code: string } } }> };

interface AcademicIds {
  sessionId: string;
  locationId: string;
  gradeOfferingId: string;
  otherGradeOfferingId: string;
  sectionId: string;
  subjectOfferingId: string;
  choiceGroupId: string;
  constraintId: string;
  programmeId: string;
  termId: string;
  subjectId: string;
  boardId: string;
  ruleVersionId: string;
}

/** Every School, Location, Setup, Master and Academic route that takes an id, pointed at the given ids. */
function routes(ids: { schoolId: string; locationId: string; identifierId: string; academic: AcademicIds }): { reads: Call[]; mutations: Call[] } {
  const s = `${API}/schools/${ids.schoolId}`;
  const l = `${API}/locations/${ids.locationId}`;
  const x = ids.academic;
  const session = `${API}/academic-sessions/${x.sessionId}`;
  const grade = `${API}/grade-offerings/${x.gradeOfferingId}`;
  const subject = `${API}/subjects/${x.subjectId}`;
  const board = `${API}/boards/${x.boardId}`;
  return {
    reads: [
      { name: 'GET school', send: (a) => a.get(s) },
      { name: 'GET identifiers', send: (a) => a.get(`${s}/identifiers`) },
      { name: 'GET locations', send: (a) => a.get(`${s}/locations`) },
      { name: 'GET code-availability', send: (a) => a.get(`${s}/locations/code-availability`).query({ code: 'ZZZ' }) },
      { name: 'GET location', send: (a) => a.get(l) },
      { name: 'GET setup-status', send: (a) => a.get(`${s}/setup-status`) },
      { name: 'GET master location', send: (c) => c.get(`${API}/master/locations/${ids.locationId}`) },
      // Academic structure (Module 2)
      { name: 'GET rule versions of a board', send: (c) => c.get(`${board}/rule-versions`) },
      { name: 'GET subject', send: (c) => c.get(subject) },
      { name: 'GET academic session', send: (c) => c.get(session) },
      { name: 'GET session grade offerings', send: (c) => c.get(`${session}/grade-offerings`) },
      { name: 'GET session terms', send: (c) => c.get(`${session}/terms`) },
      { name: 'GET grade offering', send: (c) => c.get(grade) },
      { name: 'GET sections', send: (c) => c.get(`${grade}/sections`) },
      { name: 'GET subject offerings', send: (c) => c.get(`${grade}/subjects`) },
      { name: 'GET overview', send: (c) => c.get(`${session}/overview`) },
      { name: 'GET choice groups', send: (c) => c.get(`${grade}/choice-groups`) },
      { name: 'GET constraints', send: (c) => c.get(`${grade}/constraints`) },
      { name: 'GET programmes', send: (c) => c.get(`${API}/academic-programmes`).query({ academicSessionId: x.sessionId }) },
      { name: 'GET programme', send: (c) => c.get(`${API}/academic-programmes/${x.programmeId}`) },
      { name: 'GET academic context', send: (c) => c.get(`${API}/academic-context`).query({ academicSessionId: x.sessionId, locationId: x.locationId }) },
    ],
    mutations: [
      { name: 'PATCH school', send: (a) => a.patch(s).send({ displayName: 'Hijacked' }) },
      { name: 'DELETE logo', send: (a) => a.delete(`${s}/logo`) },
      { name: 'POST identifier', send: (a) => a.post(`${s}/identifiers`).send({ identifierType: 'X', identifierValue: 'Y' }) },
      { name: 'PATCH identifier', send: (a) => a.patch(`${s}/identifiers/${ids.identifierId}`).send({ identifierValue: 'Z' }) },
      { name: 'DELETE identifier', send: (a) => a.delete(`${s}/identifiers/${ids.identifierId}`) },
      { name: 'POST location', send: (a) => a.post(`${s}/locations`).send(draftLocationBody({ locationCode: 'EVIL' })) },
      { name: 'PATCH location', send: (a) => a.patch(l).send({ displayName: 'Hijacked' }) },
      { name: 'activate', send: (a) => a.post(`${l}/activate`) },
      { name: 'deactivate', send: (a) => a.post(`${l}/deactivate`) },
      { name: 'archive', send: (a) => a.post(`${l}/archive`) },
      { name: 'set-primary', send: (a) => a.post(`${l}/set-primary`) },
      { name: 'DELETE location', send: (a) => a.delete(l) },
      { name: 'PATCH setup', send: (a) => a.patch(`${s}/setup`).send({ currentStep: 4 }) },
      { name: 'complete setup', send: (a) => a.post(`${s}/setup/complete`).send({}) },
      // Academic structure (Module 2)
      { name: 'POST rule version', send: (c) => c.post(`${board}/rule-versions`).send({ name: 'Hijack' }) },
      { name: 'publish rule version', send: (c) => c.post(`${board}/rule-versions/${x.ruleVersionId}/publish`) },
      { name: 'PATCH subject', send: (c) => c.patch(subject).send({ name: 'Hijacked' }) },
      { name: 'PUT board code', send: (c) => c.put(`${subject}/board-codes`).send({ boardRuleVersionId: x.ruleVersionId, boardSubjectCode: '999' }) },
      { name: 'DELETE board code', send: (c) => c.delete(`${subject}/board-codes/${x.ruleVersionId}`) },
      { name: 'POST session naming a foreign location', send: (c) => c.post(`${API}/academic-sessions`).send({ name: 'Evil', code: 'EVIL', startDate: '2030-04-01', endDate: '2031-03-31', locations: [{ locationId: ids.locationId, boardId: x.boardId, boardRuleVersionId: x.ruleVersionId }] }) },
      { name: 'PATCH academic session', send: (c) => c.patch(session).send({ name: 'Hijacked' }) },
      { name: 'DELETE academic session', send: (c) => c.delete(session) },
      { name: 'POST grade offerings', send: (c) => c.post(`${session}/grade-offerings`).send({ locationId: x.locationId, gradeIds: [randomUUID()] }) },
      { name: 'POST term', send: (c) => c.post(`${session}/terms`).send({ name: 'T', code: 'T9', startDate: '2026-05-01', endDate: '2026-05-31' }) },
      { name: 'PATCH grade offering', send: (c) => c.patch(grade).send({ displayName: 'Hijacked' }) },
      { name: 'DELETE grade offering', send: (c) => c.delete(grade) },
      { name: 'POST sections', send: (c) => c.post(`${grade}/sections`).send({ codes: ['Z'] }) },
      { name: 'POST subject offerings', send: (c) => c.post(`${grade}/subjects`).send({ subjectIds: [x.subjectId], offeringType: 'MANDATORY' }) },
      { name: 'copy subject offerings', send: (c) => c.post(`${grade}/subjects/copy-from/${x.otherGradeOfferingId}`) },
      { name: 'PATCH section', send: (c) => c.patch(`${API}/sections/${x.sectionId}`).send({ displayName: 'Hijacked' }) },
      { name: 'DELETE section', send: (c) => c.delete(`${API}/sections/${x.sectionId}`) },
      { name: 'PATCH subject offering', send: (c) => c.patch(`${API}/subject-offerings/${x.subjectOfferingId}`).send({ offeringType: 'ELECTIVE' }) },
      { name: 'DELETE subject offering', send: (c) => c.delete(`${API}/subject-offerings/${x.subjectOfferingId}`) },
      { name: 'PATCH term', send: (c) => c.patch(`${API}/terms/${x.termId}`).send({ name: 'Hijacked' }) },
      { name: 'DELETE term', send: (c) => c.delete(`${API}/terms/${x.termId}`) },
      // Academic rules, lifecycle and clone (Part 2)
      { name: 'validate session', send: (c) => c.post(`${session}/validate`) },
      { name: 'publish session', send: (c) => c.post(`${session}/publish`) },
      { name: 'activate session', send: (c) => c.post(`${session}/activate`) },
      { name: 'close session', send: (c) => c.post(`${session}/close`) },
      { name: 'archive session', send: (c) => c.post(`${session}/archive`) },
      { name: 'clone session', send: (c) => c.post(`${session}/clone`).send({ name: 'Copy', code: 'COPY', startDate: '2030-04-01', endDate: '2031-03-31' }) },
      { name: 'POST choice group', send: (c) => c.post(`${grade}/choice-groups`).send({ name: 'G', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [x.subjectOfferingId] }) },
      { name: 'PATCH choice group', send: (c) => c.patch(`${API}/choice-groups/${x.choiceGroupId}`).send({ name: 'Hijacked' }) },
      { name: 'DELETE choice group', send: (c) => c.delete(`${API}/choice-groups/${x.choiceGroupId}`) },
      { name: 'POST constraint', send: (c) => c.post(`${grade}/constraints`).send({ type: 'EXCLUDES', subjectOfferingId: x.subjectOfferingId, otherSubjectOfferingId: randomUUID() }) },
      { name: 'DELETE constraint', send: (c) => c.delete(`${API}/constraints/${x.constraintId}`) },
      { name: 'POST programme', send: (c) => c.post(`${API}/academic-programmes`).send({ academicSessionId: x.sessionId, locationId: x.locationId, name: 'P', code: 'P9', kind: 'FLEXIBLE', gradeFromId: randomUUID(), gradeToId: randomUUID() }) },
      { name: 'PATCH programme', send: (c) => c.patch(`${API}/academic-programmes/${x.programmeId}`).send({ name: 'Hijacked' }) },
      { name: 'DELETE programme', send: (c) => c.delete(`${API}/academic-programmes/${x.programmeId}`) },
    ],
  };
}

async function victim() {
  const b = await seededSchool('Victim School');
  const ident = await b.agent
    .post(`${API}/schools/${b.school.schoolId}/identifiers`)
    .send({ identifierType: 'Affiliation Number', identifierValue: '1630001' })
    .expect(201);

  // A small academic tree for the same school: session → grade → section / subject offering / term, plus an own board.
  const ref = await loadReference();
  const session = await createSession(b.agent, [ref.pin(b.moh.locationId), ref.pin(b.chd.locationId, 'PSEB')]);
  const subjects = await createStarterSubjects(b.agent);
  const [g6, g7] = await addGrades(b.agent, session.academicSessionId, b.moh.locationId, [ref.gradeId.G06!, ref.gradeId.G07!]);
  const section = (await b.agent.post(`${API}/grade-offerings/${g6!.gradeOfferingId}/sections`).send({ codes: ['A'] }).expect(201)).body.data[0];
  const offered = (await b.agent.post(`${API}/grade-offerings/${g6!.gradeOfferingId}/subjects`).send({ subjectIds: [subjects.MATH, subjects.SCI], offeringType: 'ELECTIVE' }).expect(201)).body.data as { subjectCode: string; subjectOfferingId: string }[];
  const offering = offered.find((o) => o.subjectCode === 'MATH')!;
  const science = offered.find((o) => o.subjectCode === 'SCI')!;
  const group = (await b.agent.post(`${API}/grade-offerings/${g6!.gradeOfferingId}/choice-groups`).send({ name: 'Electives', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [offering.subjectOfferingId, science.subjectOfferingId] }).expect(201)).body.data;
  const constraint = (await b.agent.post(`${API}/grade-offerings/${g6!.gradeOfferingId}/constraints`).send({ type: 'REQUIRES', subjectOfferingId: science.subjectOfferingId, otherSubjectOfferingId: offering.subjectOfferingId }).expect(201)).body.data;
  const programme = (
    await b.agent
      .post(`${API}/academic-programmes`)
      .send({ academicSessionId: session.academicSessionId, locationId: b.moh.locationId, name: 'Track', code: 'TRK', kind: 'STREAM', gradeFromId: ref.gradeId.G06, gradeToId: ref.gradeId.G06, subjectRules: [{ subjectOfferingId: offering.subjectOfferingId, requirement: 'REQUIRED' }] })
      .expect(201)
  ).body.data;
  const term = (await b.agent.post(`${API}/academic-sessions/${session.academicSessionId}/terms`).send({ name: 'Term 1', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201)).body.data;
  const board = (await b.agent.post(`${API}/boards`).send({ boardCode: 'VICTIM', boardName: 'Victim Board' }).expect(201)).body.data;
  const ruleVersion = (await b.agent.post(`${API}/boards/${board.boardId}/rule-versions`).send({ name: 'v1' }).expect(201)).body.data;

  const academic: AcademicIds = {
    sessionId: session.academicSessionId,
    locationId: b.moh.locationId,
    gradeOfferingId: g6!.gradeOfferingId,
    otherGradeOfferingId: g7!.gradeOfferingId,
    sectionId: section.sectionOfferingId,
    subjectOfferingId: offering.subjectOfferingId,
    choiceGroupId: group.choiceGroupId,
    constraintId: constraint.constraintId,
    programmeId: programme.programmeId,
    termId: term.termId,
    subjectId: subjects.MATH!,
    boardId: board.boardId,
    ruleVersionId: ruleVersion.ruleVersionId,
  };
  return { ...b, identifierId: ident.body.data.identifierId as string, academic };
}

/** Everything the academic routes own for a tenant, so tests can prove a refused call changed nothing. */
async function academicSnapshot(tenantId: string) {
  const models = [AcademicSession, AcademicTerm, GradeOffering, SectionOffering, SubjectOffering, Subject, EducationBoard, SubjectChoiceGroup, SubjectChoiceConstraint, AcademicProgramme] as unknown as (typeof Subject)[];
  return Promise.all(models.map((m) => m.find({ tenantId }).sort({ _id: 1 }).lean()));
}

describe('tenant isolation (SCH-LOC-15, QA 26)', () => {
  it('every school/location route returns 404 for another tenant’s ids and changes nothing', async () => {
    const attacker = await setupSchool({ workspace: 'Attacker School' });
    const b = await victim();
    const before = await Location.find({ tenantId: b.tenantId }).sort({ _id: 1 }).lean();
    const schoolBefore = await School.findOne({ tenantId: b.tenantId }).lean();
    const academicBefore = await academicSnapshot(b.tenantId);

    const { reads, mutations } = routes({ schoolId: b.school.schoolId, locationId: b.chd.locationId, identifierId: b.identifierId, academic: b.academic });
    for (const call of [...reads, ...mutations]) {
      const res = await call.send(attacker.agent);
      expect(res.status, `${call.name} → ${res.status} ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body.error?.code).toBe('NOT_FOUND');
    }

    expect(await Location.find({ tenantId: b.tenantId }).sort({ _id: 1 }).lean()).toEqual(before);
    expect(await School.findOne({ tenantId: b.tenantId }).lean()).toEqual(schoolBefore);
    expect(await academicSnapshot(b.tenantId)).toEqual(academicBefore);
  });

  it('a body cannot smuggle a tenantId or schoolId into another tenant', async () => {
    const attacker = await setupSchool({ workspace: 'Attacker School' });
    const b = await victim();
    const res = await attacker.agent
      .post(`${API}/schools/${attacker.school.schoolId}/locations`)
      .send(draftLocationBody({ tenantId: b.tenantId, schoolId: b.school.schoolId }))
      .expect(201);
    const stored = await Location.findOne({ _id: res.body.data.locationId, tenantId: attacker.tenantId }).lean();
    expect(stored).toMatchObject({ tenantId: attacker.tenantId, schoolId: attacker.school.schoolId });
  });

  it('two tenants each get their own school even with identical codes', async () => {
    const a = await setupSchool({ workspace: 'Tenant One' });
    const b = await setupSchool({ workspace: 'Tenant Two' });
    expect(a.school.schoolCode).toBe(validSchool.schoolCode);
    expect(b.school.schoolCode).toBe(validSchool.schoolCode);
    expect(a.school.schoolId).not.toBe(b.school.schoolId);
  });

  it('master APIs only ever see the caller’s tenant; foreign ids validate as NOT_FOUND', async () => {
    const attacker = await seededSchool('Attacker School');
    const b = await victim();
    const list = (await attacker.agent.get(`${API}/master/locations?scope=all`).expect(200)).body.data as { schoolId: string }[];
    expect(list.length).toBe(3);
    expect(list.every((x) => x.schoolId === attacker.school.schoolId)).toBe(true);
    const res = await attacker.agent
      .post(`${API}/master/locations/validate`)
      .send({ locationIds: [b.moh.locationId, '00000000-0000-4000-8000-000000000000'], purpose: 'HISTORICAL_READ' })
      .expect(200);
    expect(res.body.data.results.map((r: { reason: string }) => r.reason)).toEqual(['NOT_FOUND', 'NOT_FOUND']);
  });
});

describe('server-side permissions (SCH-LOC-09, QA 27/29)', () => {
  it('every protected route rejects an anonymous caller with 401', async () => {
    const b = await victim();
    const { reads, mutations } = routes({ schoolId: b.school.schoolId, locationId: b.chd.locationId, identifierId: b.identifierId, academic: b.academic });
    const anon = request.agent(app);
    for (const call of [...reads, ...mutations]) expectError(await call.send(anon), 401, 'UNAUTHENTICATED');
    for (const url of ['/schools/current', '/audit', '/master/school-context', '/master/locations']) {
      expectError(await anon.get(`${API}${url}`), 401, 'UNAUTHENTICATED');
    }
  });

  it('a role or permissions forged in headers or the body grant nothing', async () => {
    const b = await victim();
    const { agent } = await createUserAndLogin(b.tenantId, 'FACULTY');
    const res = await agent
      .post(`${API}/locations/${b.chd.locationId}/archive`)
      .set('X-User-Role', 'SCHOOL_ADMIN')
      .set('X-Permissions', 'location:archive')
      .send({ role: 'SCHOOL_ADMIN', permissions: ['location:archive'] });
    expectError(res, 403, 'FORBIDDEN');
  });

  it('Faculty, Staff and Parents are refused every mutation, even calling the API directly', async () => {
    const b = await victim();
    const { mutations } = routes({ schoolId: b.school.schoolId, locationId: b.chd.locationId, identifierId: b.identifierId, academic: b.academic });
    for (const role of ['FACULTY', 'STAFF', 'PARENT'] as const) {
      const user = await createUserAndLogin(b.tenantId, role);
      for (const call of mutations) {
        const res = await call.send(user.agent);
        expect(res.status, `${role} ${call.name}`).toBe(403);
        expect(res.body.error?.code).toBe('FORBIDDEN');
      }
      const create = await user.agent.post(`${API}/schools`).send(validSchool);
      expect(create.status, `${role} POST /schools`).toBe(403);
    }
    expect((await Location.findOne({ _id: b.chd.locationId, tenantId: b.tenantId }).lean())?.displayName).toBe('Chandigarh Campus');
  });

  it('Parents cannot read any school or location data', async () => {
    const b = await victim();
    const parent = await createUserAndLogin(b.tenantId, 'PARENT');
    const { reads } = routes({ schoolId: b.school.schoolId, locationId: b.moh.locationId, identifierId: b.identifierId, academic: b.academic });
    for (const call of reads) expect((await call.send(parent.agent)).status, call.name).toBe(403);
  });

  it('Faculty/Staff get a limited view: ACTIVE locations only, without internal fields', async () => {
    const b = await victim();
    await b.agent.patch(`${API}/locations/${b.moh.locationId}`).send({ notes: 'Gate code 1234' }).expect(200);
    await b.agent.post(`${API}/locations/${b.chd.locationId}/deactivate`).expect(200);

    for (const role of ['FACULTY', 'STAFF'] as const) {
      const user = await createUserAndLogin(b.tenantId, role);
      const list = await user.agent.get(`${API}/schools/${b.school.schoolId}/locations`).query({ status: 'DRAFT,INACTIVE,ARCHIVED' }).expect(200);
      expect(list.body.data.total).toBe(0);

      const all = await user.agent.get(`${API}/schools/${b.school.schoolId}/locations`).expect(200);
      expect(all.body.data.items.map((l: { locationCode: string }) => l.locationCode)).toEqual(['MOH']);
      expect(all.body.data.items[0]).not.toHaveProperty('notes');
      expect(all.body.data.facets.statuses).toEqual({ DRAFT: 0, ACTIVE: 1, INACTIVE: 0, ARCHIVED: 0 });

      const detail = await user.agent.get(`${API}/locations/${b.moh.locationId}`).expect(200);
      expect(detail.body.data).not.toHaveProperty('notes');
      expect(detail.body.data).toMatchObject({ codeLocked: false, deletable: false });
      await user.agent.get(`${API}/locations/${b.pkl.locationId}`).expect(404); // draft
      await user.agent.get(`${API}/locations/${b.chd.locationId}`).expect(404); // inactive
      await user.agent.get(`${API}/schools/${b.school.schoolId}/locations/code-availability`).query({ code: 'X1' }).expect(403);
      // Master: the operational list only; configuration scopes are admin-only.
      expect((await user.agent.get(`${API}/master/locations`).expect(200)).body.data).toHaveLength(1);
      expectError(await user.agent.get(`${API}/master/locations?scope=all`), 403, 'FORBIDDEN');
      expectError(await user.agent.get(`${API}/master/locations?scope=configuration`), 403, 'FORBIDDEN');
    }
  });
});

describe('audit read API (SCH-LOC-10, QA 28)', () => {
  it('returns status and Primary changes for a location, newest first, with actor names', async () => {
    const b = await seededSchool('Audit School');
    await b.agent.post(`${API}/locations/${b.chd.locationId}/set-primary`).expect(200);
    await b.agent.post(`${API}/locations/${b.moh.locationId}/deactivate`).expect(200);

    const res = await b.agent
      .get(`${API}/audit`)
      .query({ entityType: 'school_location', entityId: b.moh.locationId })
      .expect(200);
    const items = res.body.data.items as { action: string; actor: { name: string; role: string }; changes: unknown[] }[];
    expect(items.map((e) => e.action)).toEqual([
      'location.deactivated',
      'location.primary_unset',
      'location.primary_set',
      'location.created',
    ]);
    expect(items[0]!.changes).toEqual([{ field: 'status', from: 'ACTIVE', to: 'INACTIVE' }]);
    expect(items[0]!.actor).toMatchObject({ name: 'Ada Admin', role: 'SCHOOL_ADMIN' });
    expect(res.body.data.nextCursor).toBeNull();
  });

  it('paginates with an opaque cursor and stays inside the tenant', async () => {
    const b = await seededSchool('Audit School');
    const other = await seededSchool('Other School');

    const first = await b.agent.get(`${API}/audit`).query({ limit: 3 }).expect(200);
    expect(first.body.data.items).toHaveLength(3);
    const second = await b.agent.get(`${API}/audit`).query({ limit: 3, cursor: first.body.data.nextCursor }).expect(200);
    const ids = [...first.body.data.items, ...second.body.data.items].map((e: { auditEventId: string }) => e.auditEventId);
    expect(new Set(ids).size).toBe(ids.length);

    const all = await b.agent.get(`${API}/audit`).query({ limit: 100 }).expect(200);
    const foreign = await other.agent.get(`${API}/audit`).query({ entityId: b.moh.locationId }).expect(200);
    expect(foreign.body.data.items).toEqual([]);
    expect(all.body.data.items.every((e: { entityId: string }) => e.entityId !== other.moh.locationId)).toBe(true);

    await b.agent.get(`${API}/audit`).query({ cursor: 'garbage' }).expect(400);
  });

  it('only School Admins can read the audit trail', async () => {
    const b = await setupSchool({ workspace: 'Audit School' });
    for (const role of ['FACULTY', 'STAFF', 'PARENT'] as const) {
      const user = await createUserAndLogin(b.tenantId, role);
      await user.agent.get(`${API}/audit`).expect(403);
    }
  });
});
