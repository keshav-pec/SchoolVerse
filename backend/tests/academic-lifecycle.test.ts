import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AcademicContextDTO, AcademicContextGradesDTO, AcademicOverviewDTO, AcademicSessionDTO, AcademicTermDTO, ValidationResultDTO } from '@shared';
import { academicService } from '../src/modules/academic/academic.service';
import { seedDemo } from '../src/scripts/seed';
import { registerAcademicDependency, unregisterAcademicDependency } from '../src/modules/academic/dependencies';
import { GradeOffering, SectionOffering, SubjectOffering } from '../src/modules/academic/offering.model';
import { AcademicProgramme, SubjectChoiceConstraint, SubjectChoiceGroup } from '../src/modules/academic/rules.model';
import { shiftDate } from '../src/modules/academic/clone.service';
import { AcademicSession, AcademicTerm } from '../src/modules/academic/session.model';
import {
  addGrades,
  API,
  app,
  auditForSession,
  createUserAndLogin,
  draftSession,
  expectError,
  forceStatus,
  loadReference,
  makePublishable,
  offer,
  serviceContextFor,
  useTestDatabase,
  type DraftSession,
} from './helpers';

useTestDatabase();
beforeEach(async () => {
  await loadReference();
});

const act = (t: DraftSession, action: string, id = t.id) => t.agent.post(`${API}/academic-sessions/${id}/${action}`);
const get = async <T>(t: DraftSession, path: string) => (await t.agent.get(`${API}${path}`).expect(200)).body.data as T;
const sessionOf = (t: DraftSession, id = t.id) => get<AcademicSessionDTO>(t, `/academic-sessions/${id}`);
const clone = (t: DraftSession, body: Record<string, unknown> = {}, id = t.id) =>
  t.agent.post(`${API}/academic-sessions/${id}/clone`).send({ name: 'Academic Year 2027-28', code: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31', ...body });

/** A complete plan: Grade 6 at Mohali with two sections, three subjects (one with a CBSE code), a group, a rule, a programme and two terms. */
async function rich() {
  const t = await draftSession();
  await t.agent.put(`${API}/subjects/${t.subjects.MATH}/board-codes`).send({ boardRuleVersionId: t.ref.ruleVersionId('CBSE'), boardSubjectCode: '041' }).expect(200);
  const [g6] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G06!]);
  const gradeOfferingId = g6!.gradeOfferingId;
  const sections = (await t.agent.post(`${API}/grade-offerings/${gradeOfferingId}/sections`).send({ codes: ['A', 'B'] }).expect(201)).body.data as { sectionOfferingId: string }[];
  const o = await offer(t.agent, gradeOfferingId, [t.subjects.MATH!, t.subjects.SCI!, t.subjects.ENG!], 'ELECTIVE');
  const group = (await t.agent.post(`${API}/grade-offerings/${gradeOfferingId}/choice-groups`).send({ name: 'Electives', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [o.MATH, o.SCI] }).expect(201)).body.data;
  const constraint = (await t.agent.post(`${API}/grade-offerings/${gradeOfferingId}/constraints`).send({ type: 'REQUIRES', subjectOfferingId: o.SCI, otherSubjectOfferingId: o.ENG }).expect(201)).body.data;
  const programme = (
    await t.agent
      .post(`${API}/academic-programmes`)
      .send({ academicSessionId: t.id, locationId: t.moh.locationId, name: 'Grade 6 track', code: 'P6', kind: 'STREAM', gradeFromId: t.ref.gradeId.G06, gradeToId: t.ref.gradeId.G06, subjectRules: [{ subjectOfferingId: o.MATH, requirement: 'REQUIRED' }] })
      .expect(201)
  ).body.data;
  const term1 = (await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'Term 1', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201)).body.data;
  const term2 = (await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'Term 2', code: 'T2', startDate: '2026-10-01', endDate: '2027-03-31' }).expect(201)).body.data;
  return {
    ...t,
    gradeOfferingId,
    sectionIds: sections.map((s) => s.sectionOfferingId),
    o,
    groupId: group.choiceGroupId as string,
    constraintId: constraint.constraintId as string,
    programmeId: programme.programmeId as string,
    termIds: [term1.termId as string, term2.termId as string],
  };
}

async function activate(t: DraftSession) {
  await act(t, 'publish').expect(200);
  await act(t, 'activate').expect(200);
}

describe('validate → publish → activate (AS-14, AS-15)', () => {
  it('QA 16: validation is stored, an error blocks publishing with the full list, and a clean plan publishes and activates', async () => {
    const t = await draftSession();
    expect((await sessionOf(t)).lastValidation).toBeNull();

    const empty = (await act(t, 'validate').expect(200)).body.data as ValidationResultDTO;
    expect(empty.canPublish).toBe(false);
    expect(empty.issues.map((i) => i.code)).toContain('NO_GRADE_OFFERINGS');
    expect(empty.summary.errors).toBeGreaterThan(0);
    expect((await sessionOf(t)).lastValidation).toMatchObject({ errors: empty.summary.errors, warnings: empty.summary.warnings });

    // Publishing re-runs validation and refuses, naming every error.
    const blocked = expectError(await act(t, 'publish'), 400, 'VALIDATION_FAILED');
    expect(blocked.message).toMatch(/^Fix \d+ errors? before you publish/);
    expect((blocked.details as unknown as { issues: { level: string; code: string }[] }).issues.filter((i) => i.level === 'ERROR').map((i) => i.code)).toContain('NO_GRADE_OFFERINGS');
    expect((await sessionOf(t)).status).toBe('DRAFT');

    const plan = await makePublishable(t);
    const clean = (await act(t, 'validate').expect(200)).body.data as ValidationResultDTO;
    expect(clean).toMatchObject({ canPublish: true, summary: { errors: 0, warnings: 0, info: 0 } });
    expect((await sessionOf(t)).lastValidation).toMatchObject({ errors: 0 });

    // Warnings and info never block: without terms the plan still publishes.
    await t.agent.delete(`${API}/terms/${plan.termId}`).expect(204);
    const noTerms = (await act(t, 'validate').expect(200)).body.data as ValidationResultDTO;
    expect(noTerms.canPublish).toBe(true);
    expect(noTerms.issues.map((i) => `${i.level}:${i.code}`)).toEqual(['WARNING:GRADE_WITHOUT_TERMS', 'INFO:NO_TERMS']);

    const published = (await act(t, 'publish').expect(200)).body.data as AcademicSessionDTO;
    expect(published).toMatchObject({ status: 'PUBLISHED', isCurrent: false, deletable: false });
    // A published plan can still be edited (nobody has used it yet)…
    await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'Term 1', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201);

    const active = (await act(t, 'activate').expect(200)).body.data as AcademicSessionDTO;
    expect(active).toMatchObject({ status: 'ACTIVE', isCurrent: true });
    expect(await get<AcademicSessionDTO>(t, '/academic-sessions/current')).toMatchObject({ academicSessionId: t.id, status: 'ACTIVE' });
  });

  it('only the documented moves are allowed', async () => {
    const t = await draftSession();
    const allowed: Record<string, string> = { DRAFT: 'publish', PUBLISHED: 'activate', ACTIVE: 'close', CLOSED: 'archive', ARCHIVED: '' };
    for (const [status, ok] of Object.entries(allowed)) {
      for (const action of ['publish', 'activate', 'close', 'archive']) {
        if (action === ok) continue;
        await forceStatus(t.tenantId, t.id, status as AcademicSessionDTO['status']);
        const err = expectError(await act(t, action), 409, 'INVALID_STATUS_TRANSITION');
        expect(err.details).toMatchObject({ from: status, action });
      }
    }
    // ARCHIVED is read-only, and `status` is not a field PATCH can set.
    expectError(await t.agent.patch(t.sessionUrl).send({ status: 'ACTIVE', name: 'x' }), 409, 'SESSION_READ_ONLY');
  });

  it('activating checks the plan again: a location that went inactive after publishing blocks activation', async () => {
    const t = await draftSession();
    await makePublishable(t);
    await act(t, 'publish').expect(200);
    await t.agent.post(`${API}/locations/${t.chd.locationId}/deactivate`).expect(200);

    const err = expectError(await act(t, 'activate'), 400, 'VALIDATION_FAILED');
    expect((err.details as unknown as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain('LOCATION_NOT_ACTIVE');
    expect((await sessionOf(t)).status).toBe('PUBLISHED');

    // A published plan can be fixed, then activated.
    const keepMohali = [{ locationId: t.moh.locationId, boardId: t.ref.boardId.CBSE, boardRuleVersionId: t.ref.ruleVersionId('CBSE') }];
    await t.agent.patch(t.sessionUrl).send({ locations: keepMohali }).expect(200);
    await act(t, 'activate').expect(200);
  });

  it('only one session per school can be ACTIVE — including two concurrent activations', async () => {
    const a = await draftSession();
    await makePublishable(a);
    await act(a, 'publish').expect(200);
    const b = (await clone(a).expect(201)).body.data as AcademicSessionDTO;
    await act(a, 'publish', b.academicSessionId).expect(200);

    await act(a, 'activate').expect(200);
    const refused = expectError(await act(a, 'activate', b.academicSessionId), 409, 'ANOTHER_SESSION_ACTIVE');
    expect(refused.details.activeSession).toMatchObject({ academicSessionId: a.id, code: '2026-27' });

    await act(a, 'close').expect(200);
    await act(a, 'activate', b.academicSessionId).expect(200);
    expect((await get<AcademicSessionDTO>(a, '/academic-sessions/current')).academicSessionId).toBe(b.academicSessionId);

    // Race: close B, then activate both published sessions at once.
    await act(a, 'close', b.academicSessionId).expect(200);
    const c = (await clone(a, { name: 'AY 2028-29', code: '2028-29', startDate: '2028-04-01', endDate: '2029-03-31' }, b.academicSessionId).expect(201)).body.data as AcademicSessionDTO;
    await act(a, 'publish', c.academicSessionId).expect(200);
    await forceStatus(a.tenantId, a.id, 'PUBLISHED');
    await forceStatus(a.tenantId, b.academicSessionId, 'PUBLISHED');
    const results = await Promise.all([act(a, 'activate', a.id), act(a, 'activate', b.academicSessionId), act(a, 'activate', c.academicSessionId)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.error.code).toBe('ANOTHER_SESSION_ACTIVE');
    expect(await AcademicSession.countDocuments({ tenantId: a.tenantId, status: 'ACTIVE' })).toBe(1);
  });

  it('two schools can each have their own ACTIVE session', async () => {
    const a = await draftSession();
    await makePublishable(a);
    await activate(a);
    const b = await draftSession();
    await makePublishable(b);
    await activate(b);
    for (const school of [a, b]) expect(await AcademicSession.countDocuments({ tenantId: school.tenantId, status: 'ACTIVE' })).toBe(1);
  });
});

describe('closing (AS-15)', () => {
  it('QA 18: a CLOSED session stays fully readable but nothing in it can change; archiving is the last step', async () => {
    const t = await rich();
    await activate(t);
    await act(t, 'close').expect(200);
    expect(await sessionOf(t)).toMatchObject({ status: 'CLOSED', isCurrent: false, deletable: false });
    expectError(await t.agent.get(`${API}/academic-sessions/current`), 404, 'NOT_FOUND');

    const refused = {
      'PATCH session': t.agent.patch(t.sessionUrl).send({ name: 'x' }),
      'validate': act(t, 'validate'),
      'POST grade': t.agent.post(`${t.sessionUrl}/grade-offerings`).send({ locationId: t.moh.locationId, gradeIds: [t.ref.gradeId.G07!] }),
      'PATCH grade': t.agent.patch(`${API}/grade-offerings/${t.gradeOfferingId}`).send({ displayName: 'x' }),
      'POST section': t.agent.post(`${API}/grade-offerings/${t.gradeOfferingId}/sections`).send({ codes: ['Z'] }),
      'PATCH subject offering': t.agent.patch(`${API}/subject-offerings/${t.o.MATH}`).send({ offeringType: 'MANDATORY' }),
      'POST group': t.agent.post(`${API}/grade-offerings/${t.gradeOfferingId}/choice-groups`).send({ name: 'x', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.ENG] }),
      'PATCH group': t.agent.patch(`${API}/choice-groups/${t.groupId}`).send({ name: 'x' }),
      'DELETE group': t.agent.delete(`${API}/choice-groups/${t.groupId}`),
      'POST constraint': t.agent.post(`${API}/grade-offerings/${t.gradeOfferingId}/constraints`).send({ type: 'EXCLUDES', subjectOfferingId: t.o.MATH, otherSubjectOfferingId: t.o.ENG }),
      'DELETE constraint': t.agent.delete(`${API}/constraints/${t.constraintId}`),
      'PATCH programme': t.agent.patch(`${API}/academic-programmes/${t.programmeId}`).send({ name: 'x' }),
      'DELETE programme': t.agent.delete(`${API}/academic-programmes/${t.programmeId}`),
      'POST term': t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'x', code: 'X', startDate: '2026-05-01', endDate: '2026-05-02' }),
      'DELETE term': t.agent.delete(`${API}/terms/${t.termIds[0]}`),
      'DELETE session': t.agent.delete(t.sessionUrl),
    };
    for (const [name, pending] of Object.entries(refused)) {
      const res = await pending;
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(409);
      expect(res.body.error.code, name).toBe(name === 'DELETE session' ? 'SESSION_NOT_DRAFT' : 'SESSION_READ_ONLY');
    }
    for (const action of ['publish', 'activate', 'close']) expectError(await act(t, action), 409, 'INVALID_STATUS_TRANSITION');

    // Everything is still there to read, and a closed session is the natural source for next year's plan.
    expect(await get<unknown[]>(t, `/academic-sessions/${t.id}/grade-offerings`)).toHaveLength(1);
    expect(await get<unknown[]>(t, `/grade-offerings/${t.gradeOfferingId}/choice-groups`)).toHaveLength(1);
    expect(await get<unknown[]>(t, `/academic-programmes?academicSessionId=${t.id}`)).toHaveLength(1);
    expect(await get<unknown[]>(t, `/academic-sessions/${t.id}/terms`)).toHaveLength(2);
    expect(await GradeOffering.countDocuments({ tenantId: t.tenantId, sessionId: t.id })).toBe(1);
    await clone(t).expect(201);

    expect(await act(t, 'archive').expect(200).then((r) => r.body.data.status)).toBe('ARCHIVED');
    expect(await sessionOf(t)).toMatchObject({ status: 'ARCHIVED' });
    expectError(await t.agent.patch(t.sessionUrl).send({ name: 'x' }), 409, 'SESSION_READ_ONLY');
    expectError(await act(t, 'archive'), 409, 'INVALID_STATUS_TRANSITION');
  });
});

describe('unsafe changes on an ACTIVE session (AS-15)', () => {
  /** A stand-in for Faculty / Student modules: says every id in `inUse` is referenced by downstream records. */
  const inUse = new Set<string>();
  const KEY = 'test.downstream';
  function registerStub() {
    inUse.clear();
    registerAcademicDependency({
      key: KEY,
      label: 'Faculty assignments',
      entityTypes: ['grade_offering', 'section_offering', 'subject_offering', 'academic_term', 'session_location', 'choice_group', 'constraint', 'programme'],
      count: async ({ entityId }) => (inUse.has(entityId) ? 3 : 0),
      message: (n) => `${n} faculty assignments use this.`,
    });
  }

  it('QA 17: deactivating or removing structure is refused when downstream records use it; the same change is fine on a DRAFT', async () => {
    const t = await rich();
    registerStub();
    try {
      for (const id of [t.gradeOfferingId, ...t.sectionIds, t.o.MATH!, t.groupId, t.constraintId, t.programmeId, ...t.termIds, t.moh.locationId, t.chd.locationId]) inUse.add(id);

      // DRAFT: nothing downstream can exist yet, so the guard stays out of the way.
      const draftChange = await t.agent.patch(`${API}/sections/${t.sectionIds[1]}`).send({ status: 'INACTIVE' }).expect(200);
      expect(draftChange.body.data.status).toBe('INACTIVE');
      await t.agent.patch(`${API}/sections/${t.sectionIds[1]}`).send({ status: 'ACTIVE' }).expect(200);

      await activate(t);
      const before = await auditForSession(t.agent, t.id);

      const blocked: [string, ReturnType<typeof t.agent.patch>][] = [
        ['grade offering', t.agent.patch(`${API}/grade-offerings/${t.gradeOfferingId}`).send({ status: 'INACTIVE' })],
        ['section', t.agent.patch(`${API}/sections/${t.sectionIds[0]}`).send({ status: 'INACTIVE' })],
        ['subject offering', t.agent.patch(`${API}/subject-offerings/${t.o.MATH}`).send({ status: 'INACTIVE' })],
        ['group deactivate', t.agent.patch(`${API}/choice-groups/${t.groupId}`).send({ status: 'INACTIVE' })],
        ['group remove item', t.agent.patch(`${API}/choice-groups/${t.groupId}`).send({ subjectOfferingIds: [t.o.SCI] })],
        ['programme', t.agent.patch(`${API}/academic-programmes/${t.programmeId}`).send({ status: 'INACTIVE' })],
        ['constraint', t.agent.delete(`${API}/constraints/${t.constraintId}`) as never],
        ['term', t.agent.delete(`${API}/terms/${t.termIds[0]}`) as never],
        ['remove location', t.agent.patch(t.sessionUrl).send({ locations: [{ locationId: t.moh.locationId, boardId: t.ref.boardId.CBSE, boardRuleVersionId: t.ref.ruleVersionId('CBSE') }] })],
      ];
      for (const [name, pending] of blocked) {
        const res = await pending;
        const err = expectError(res, 409, 'ACADEMIC_HAS_DEPENDENCIES');
        expect(err.details.dependencies, name).toMatchObject([{ key: KEY, label: 'Faculty assignments', count: 3, message: '3 faculty assignments use this.' }]);
      }
      // Blocked means unchanged: no row moved and no audit row was written.
      expect((await SectionOffering.findOne({ _id: t.sectionIds[0], tenantId: t.tenantId }).lean())?.status).toBe('ACTIVE');
      expect(await SubjectChoiceConstraint.countDocuments({ tenantId: t.tenantId })).toBe(1);
      expect(await AcademicTerm.countDocuments({ tenantId: t.tenantId, sessionId: t.id })).toBe(2);
      expect((await auditForSession(t.agent, t.id)).length).toBe(before.length);

      // Display edits and additions are always fine on an ACTIVE session.
      await t.agent.patch(`${API}/sections/${t.sectionIds[0]}`).send({ displayName: 'Rose' }).expect(200);
      await t.agent.patch(`${API}/choice-groups/${t.groupId}`).send({ name: 'Electives (renamed)' }).expect(200);
      await t.agent.post(`${API}/grade-offerings/${t.gradeOfferingId}/sections`).send({ codes: ['C'] }).expect(201);
      const [g7] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G07!]);
      expect(g7).toBeTruthy();

      // Once nothing references them any more, the same changes go through.
      inUse.clear();
      await t.agent.patch(`${API}/sections/${t.sectionIds[0]}`).send({ status: 'INACTIVE' }).expect(200);
      await t.agent.delete(`${API}/constraints/${t.constraintId}`).expect(204);
      await t.agent.delete(`${API}/terms/${t.termIds[0]}`).expect(204);
    } finally {
      unregisterAcademicDependency(KEY);
    }
  });
});

describe('clone / roll forward (AS-13)', () => {
  it('QA 2: copies the plan with new ids and shifted term dates, and never touches the original or anything else', async () => {
    const t = await rich();
    await t.agent.patch(`${API}/sections/${t.sectionIds[1]}`).send({ status: 'INACTIVE' }).expect(200); // inactive rows are left behind
    await t.agent.patch(t.sessionUrl).send({ locations: [
      { locationId: t.moh.locationId, boardId: t.ref.boardId.CBSE, boardRuleVersionId: t.ref.ruleVersionId('CBSE'), affiliationNumber: '1630457' },
      { locationId: t.chd.locationId, boardId: t.ref.boardId.PSEB, boardRuleVersionId: t.ref.ruleVersionId('PSEB') },
    ] }).expect(200);
    const original = await sessionOf(t);
    const countsBefore = await Promise.all([GradeOffering, SectionOffering, SubjectOffering, SubjectChoiceGroup, SubjectChoiceConstraint, AcademicProgramme, AcademicTerm].map((m) => (m as typeof GradeOffering).countDocuments({ tenantId: t.tenantId, sessionId: t.id })));

    const res = await clone(t);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const copy = res.body.data as AcademicSessionDTO;
    const copyUrl = `/academic-sessions/${copy.academicSessionId}`;
    expect(copy).toMatchObject({ status: 'DRAFT', code: '2027-28', name: 'Academic Year 2027-28', previousSessionId: t.id, startDate: '2027-04-01', endDate: '2028-03-31', isCurrent: false });
    expect(copy.academicSessionId).not.toBe(t.id);
    expect(copy.locations.map((l) => `${l.locationCode}:${l.boardCode}:${l.ruleVersionName}:${l.affiliationNumber}`)).toEqual(['MOH:CBSE:2026-27:1630457', 'CHD:PSEB:2026-27:null']);

    // Structure came across with NEW ids.
    const grades = await get<{ gradeOfferingId: string; displayName: string; sectionCount: number; subjectCount: number }[]>(t, `${copyUrl}/grade-offerings`);
    expect(grades).toMatchObject([{ displayName: 'Grade 6', sectionCount: 1, subjectCount: 3 }]); // section B was inactive
    expect(grades[0]!.gradeOfferingId).not.toBe(t.gradeOfferingId);
    const newGrade = grades[0]!.gradeOfferingId;
    const sections = await get<{ sectionCode: string; sectionOfferingId: string }[]>(t, `/grade-offerings/${newGrade}/sections`);
    expect(sections.map((s) => s.sectionCode)).toEqual(['A']);
    expect(t.sectionIds).not.toContain(sections[0]!.sectionOfferingId);
    const offerings = await get<{ subjectOfferingId: string; subjectCode: string; boardSubjectCode: string | null }[]>(t, `/grade-offerings/${newGrade}/subjects`);
    expect(offerings.map((o) => o.subjectCode).sort()).toEqual(['ENG', 'MATH', 'SCI']);
    expect(offerings.find((o) => o.subjectCode === 'MATH')?.boardSubjectCode).toBe('041'); // board code mapping travels with the pinned rule version
    const oldIds = Object.values(t.o);
    expect(offerings.some((o) => oldIds.includes(o.subjectOfferingId))).toBe(false);

    // Rules point at the NEW offerings.
    const newId = (code: string) => offerings.find((o) => o.subjectCode === code)!.subjectOfferingId;
    const groups = await get<{ name: string; ruleType: string; subjects: { subjectOfferingId: string }[] }[]>(t, `/grade-offerings/${newGrade}/choice-groups`);
    expect(groups).toMatchObject([{ name: 'Electives', ruleType: 'CHOOSE_ONE' }]);
    expect(groups[0]!.subjects.map((s) => s.subjectOfferingId).sort()).toEqual([newId('MATH'), newId('SCI')].sort());
    const constraints = await get<{ subjectOfferingId: string; otherSubjectOfferingId: string; type: string }[]>(t, `/grade-offerings/${newGrade}/constraints`);
    expect(constraints).toMatchObject([{ type: 'REQUIRES', subjectOfferingId: newId('SCI'), otherSubjectOfferingId: newId('ENG') }]);
    const programmes = await get<{ code: string; subjectRules: { subjectOfferingId: string }[] }[]>(t, `/academic-programmes?academicSessionId=${copy.academicSessionId}`);
    expect(programmes).toMatchObject([{ code: 'P6', subjectRules: [{ subjectOfferingId: newId('MATH') }] }]);

    // Terms move by the difference between the two start dates (365 days here; 2028 is a leap year, so the last day lands on 30 March).
    const terms = await get<AcademicTermDTO[]>(t, `${copyUrl}/terms`);
    expect(terms.map((x) => [x.code, x.startDate, x.endDate])).toEqual([
      ['T1', '2027-04-01', '2027-09-30'],
      ['T2', '2027-10-01', '2028-03-30'],
    ]);
    expect(shiftDate('2026-04-01', 365)).toBe('2027-04-01');
    expect(shiftDate('2027-03-01', -365)).toBe('2026-03-01');

    // The clone is a normal draft that validates, and the original did not move.
    expect(((await act(t, 'validate', copy.academicSessionId).expect(200)).body.data as ValidationResultDTO).canPublish).toBe(true);
    const { lastValidation: _a, updatedAt: _b, ...originalNow } = await sessionOf(t);
    const { lastValidation: _c, updatedAt: _d, ...originalBefore } = original;
    expect(originalNow).toEqual(originalBefore);
    const countsAfter = await Promise.all([GradeOffering, SectionOffering, SubjectOffering, SubjectChoiceGroup, SubjectChoiceConstraint, AcademicProgramme, AcademicTerm].map((m) => (m as typeof GradeOffering).countDocuments({ tenantId: t.tenantId, sessionId: t.id })));
    expect(countsAfter).toEqual(countsBefore);

    const event = (await auditForSession(t.agent, copy.academicSessionId)).find((e) => e.action === 'academic_session.cloned')!;
    expect(event.metadata).toMatchObject({ clonedFromSessionId: t.id, termShiftDays: 365, copied: { gradeOfferings: 1, sections: 1, subjectOfferings: 3, choiceGroups: 1, constraints: 1, programmes: 1, terms: 2 } });
  });

  it('refuses a taken code or bad dates, needs the publish permission, and starts from any visible session', async () => {
    const t = await rich();
    expectError(await clone(t, { code: '2026-27' }), 409, 'SESSION_CODE_TAKEN');
    expectError(await clone(t, { startDate: '2028-04-01', endDate: '2027-04-01' }), 400, 'SESSION_DATES_INVALID');
    expect(expectError(await clone(t, { startDate: 'soon' }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('startDate');
    expectError(await clone(t, {}, '6f0b3e0a-1f2e-4d5b-8c1a-0a1b2c3d4e5f'), 404, 'NOT_FOUND');
    expect(await AcademicSession.countDocuments({ tenantId: t.tenantId })).toBe(1); // nothing half-created
    expect(await GradeOffering.countDocuments({ tenantId: t.tenantId })).toBe(1);

    const faculty = await createUserAndLogin(t.tenantId, 'FACULTY');
    expectError(await faculty.agent.post(`${t.sessionUrl}/clone`).send({ name: 'x', code: 'X1', startDate: '2027-04-01', endDate: '2028-03-31' }), 403, 'FORBIDDEN');
  });
});

describe('overview, academic context and current session (AS-16, AS-18)', () => {
  it('the overview reports counts, boards and a checklist that follows the plan', async () => {
    const t = await draftSession();
    const empty = await get<AcademicOverviewDTO>(t, `/academic-sessions/${t.id}/overview`);
    expect(empty.counts).toEqual({ locations: 2, grades: 0, sections: 0, subjects: 0, programmes: 0, terms: 0, choiceGroups: 0 });
    expect(empty.boards.map((b) => `${b.locationCode}:${b.boardCode}`)).toEqual(['MOH:CBSE', 'CHD:PSEB']);
    const status = (o: AcademicOverviewDTO) => Object.fromEntries(o.checklist.map((c) => [c.key, c.status]));
    expect(status(empty)).toEqual({ session: 'completed', board: 'completed', grades: 'pending', sections: 'pending', subjects: 'pending', rules: 'optional', terms: 'optional', validation: 'pending' });

    const full = await rich();
    await act(full, 'validate').expect(200);
    const o = await get<AcademicOverviewDTO>(full, `/academic-sessions/${full.id}/overview`);
    expect(o.counts).toEqual({ locations: 2, grades: 1, sections: 2, subjects: 3, programmes: 1, terms: 2, choiceGroups: 1 });
    expect(status(o)).toEqual({ session: 'completed', board: 'completed', grades: 'completed', sections: 'completed', subjects: 'completed', rules: 'completed', terms: 'completed', validation: 'completed' });
    expect(o.lastValidation).toMatchObject({ errors: 0 });

    const faculty = await createUserAndLogin(full.tenantId, 'FACULTY');
    expectError(await faculty.agent.get(`${full.sessionUrl}/overview`), 403, 'FORBIDDEN');
  });

  it('AS-18: the context lists a location’s grades, or returns the whole tree for one grade', async () => {
    const t = await rich();
    await activate(t);
    const query = (extra: Record<string, string> = {}) => t.agent.get(`${API}/academic-context`).query({ academicSessionId: t.id, locationId: t.moh.locationId, ...extra });

    const list = (await query().expect(200)).body.data as AcademicContextGradesDTO;
    expect(list).toMatchObject({ sessionStatus: 'ACTIVE', board: { boardCode: 'CBSE', ruleVersionName: '2026-27' } });
    expect(list.grades.map((g) => g.displayName)).toEqual(['Grade 6']);
    expect(list).not.toHaveProperty('sections');

    const tree = (await query({ gradeId: t.ref.gradeId.G06! }).expect(200)).body.data as AcademicContextDTO;
    expect(tree.gradeOffering).toMatchObject({ gradeOfferingId: t.gradeOfferingId, canonicalCode: 'G06' });
    expect(tree.sections.map((s) => s.sectionCode)).toEqual(['A', 'B']);
    expect(tree.subjectOfferings.map((s) => `${s.subjectCode}:${s.boardSubjectCode}`).sort()).toEqual(['ENG:null', 'MATH:041', 'SCI:null']);
    expect(tree.choiceGroups.map((g) => g.summary)).toEqual(['Choose 1 of Mathematics, Science']);
    expect(tree.constraints.map((c) => c.summary)).toEqual(['Science requires English']);
    expect(tree.programmes.map((p) => p.code)).toEqual(['P6']);
    expect(tree.terms.map((x) => x.code)).toEqual(['T1', 'T2']);

    expectError(await query({ locationId: t.pkl.locationId }), 409, 'LOCATION_NOT_IN_SESSION');
    expectError(await query({ gradeId: t.ref.gradeId.G07! }), 404, 'NOT_FOUND');
    expect(expectError(await t.agent.get(`${API}/academic-context`).query({ academicSessionId: t.id }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('locationId');
  });

  it('Faculty and Staff read the context for PUBLISHED, ACTIVE and CLOSED sessions only; Parents get nothing', async () => {
    const t = await rich();
    const draftCopy = (await clone(t).expect(201)).body.data as AcademicSessionDTO;
    const faculty = await createUserAndLogin(t.tenantId, 'FACULTY');
    const staff = await createUserAndLogin(t.tenantId, 'STAFF');
    const parent = await createUserAndLogin(t.tenantId, 'PARENT');
    const ask = (agent: typeof faculty.agent, academicSessionId: string) =>
      agent.get(`${API}/academic-context`).query({ academicSessionId, locationId: t.moh.locationId, gradeId: t.ref.gradeId.G06! });

    for (const user of [faculty, staff]) {
      expectError(await ask(user.agent, t.id), 404, 'NOT_FOUND'); // still a draft
      expectError(await user.agent.get(`${API}/academic-sessions/current`), 404, 'NOT_FOUND');
    }
    await activate(t);
    for (const user of [faculty, staff]) {
      expect((await ask(user.agent, t.id).expect(200)).body.data.gradeOffering.gradeOfferingId).toBe(t.gradeOfferingId);
      expect((await user.agent.get(`${API}/academic-sessions/current`).expect(200)).body.data.academicSessionId).toBe(t.id);
      expectError(await ask(user.agent, draftCopy.academicSessionId), 404, 'NOT_FOUND');
      expectError(await user.agent.get(`${API}/academic-programmes`).query({ academicSessionId: draftCopy.academicSessionId }), 404, 'NOT_FOUND');
    }
    await act(t, 'close').expect(200);
    await ask(faculty.agent, t.id).expect(200);
    await act(t, 'archive').expect(200);
    expectError(await ask(faculty.agent, t.id), 404, 'NOT_FOUND');
    expectError(await ask(parent.agent, t.id), 403, 'FORBIDDEN');
  });
});

describe('integration: a downstream module through academicService (AS-18)', () => {
  /** A dev-only fake "faculty assignment" module: it resolves Location → Session → Grade → Section → Subject, stores only offering ids, and registers itself as a dependency. */
  function facultyModule() {
    const assignments: { sectionOfferingId: string; subjectOfferingId: string }[] = [];
    const KEY = 'test.faculty-assignments';
    registerAcademicDependency({
      key: KEY,
      label: 'Faculty assignments',
      entityTypes: ['section_offering', 'subject_offering'],
      count: async ({ entityId }) => assignments.filter((a) => a.sectionOfferingId === entityId || a.subjectOfferingId === entityId).length,
      message: (n) => `${n} faculty assignment${n === 1 ? '' : 's'} use this.`,
    });
    return {
      assignments,
      dispose: () => unregisterAcademicDependency(KEY),
      async assign(ctx: ReturnType<typeof serviceContextFor>, sectionOfferingId: string, subjectOfferingId: string) {
        await academicService.assertSectionUsable(ctx, sectionOfferingId, { purpose: 'NEW_ASSIGNMENT' });
        await academicService.assertSubjectOfferingUsable(ctx, subjectOfferingId, { purpose: 'NEW_ASSIGNMENT' });
        assignments.push({ sectionOfferingId, subjectOfferingId });
      },
    };
  }

  it('resolves the chain, allows history on a closed session but refuses new assignments, and blocks the unsafe change', async () => {
    const t = await rich();
    const faculty = facultyModule();
    try {
      const [sectionA, sectionB] = t.sectionIds as [string, string];
      // Draft: not open for assignments.
      await expect(faculty.assign(t.ctx, sectionA, t.o.MATH!)).rejects.toMatchObject({ code: 'ACADEMIC_NOT_USABLE', details: { reason: 'SESSION_NOT_OPEN', status: 'DRAFT' } });
      // …and invisible to a limited role (they never see drafts).
      const limited = serviceContextFor(t.tenantId, 'someone', 'FACULTY');
      await expect(academicService.assertSectionUsable(limited, sectionA, { purpose: 'HISTORICAL_READ' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await act(t, 'publish').expect(200);
      await faculty.assign(t.ctx, sectionA, t.o.MATH!); // PUBLISHED accepts new assignments
      await act(t, 'activate').expect(200);
      await faculty.assign(t.ctx, sectionA, t.o.SCI!);

      const usable = await academicService.assertSectionUsable(t.ctx, sectionA, { purpose: 'NEW_ASSIGNMENT' });
      expect(usable).toMatchObject({
        location: { locationCode: 'MOH', displayName: 'Mohali Campus' },
        session: { code: '2026-27', status: 'ACTIVE' },
        gradeOffering: { gradeOfferingId: t.gradeOfferingId, displayName: 'Grade 6' },
        section: { sectionOfferingId: sectionA, sectionCode: 'A' },
      });
      expect(await academicService.assertSubjectOfferingUsable(t.ctx, t.o.MATH!, { purpose: 'NEW_ASSIGNMENT' })).toMatchObject({
        subjectOffering: { subjectOfferingId: t.o.MATH, subjectName: 'Mathematics', offeringType: 'ELECTIVE' },
        gradeOffering: { displayName: 'Grade 6' },
      });
      // The context call is the same data the HTTP route serves.
      const context = (await academicService.getContext(t.ctx, { academicSessionId: t.id, locationId: t.moh.locationId, gradeId: t.ref.gradeId.G06! })) as AcademicContextDTO;
      expect(context.sections).toHaveLength(2);

      // QA 17 through the module: the section is in use, so it cannot be deactivated; the unused one can, and then refuses new work.
      const blocked = expectError(await t.agent.patch(`${API}/sections/${sectionA}`).send({ status: 'INACTIVE' }), 409, 'ACADEMIC_HAS_DEPENDENCIES');
      expect(blocked.details.dependencies).toMatchObject([{ key: 'test.faculty-assignments', count: 2 }]);
      await t.agent.patch(`${API}/sections/${sectionB}`).send({ status: 'INACTIVE' }).expect(200);
      await expect(faculty.assign(t.ctx, sectionB, t.o.MATH!)).rejects.toMatchObject({ details: { reason: 'SECTION_INACTIVE' } });
      expect(await academicService.assertSectionUsable(t.ctx, sectionB, { purpose: 'HISTORICAL_READ' })).toMatchObject({ section: { sectionCode: 'B' } });

      // Closed: history is still readable, new assignments are not.
      await act(t, 'close').expect(200);
      expect(await academicService.assertSectionUsable(t.ctx, sectionA, { purpose: 'HISTORICAL_READ' })).toMatchObject({ purpose: 'HISTORICAL_READ', session: { status: 'CLOSED' } });
      await expect(academicService.assertSectionUsable(t.ctx, sectionA, { purpose: 'NEW_ASSIGNMENT' })).rejects.toMatchObject({ code: 'ACADEMIC_NOT_USABLE', details: { reason: 'SESSION_NOT_OPEN', status: 'CLOSED' } });
      await expect(faculty.assign(t.ctx, sectionA, t.o.ENG!)).rejects.toMatchObject({ code: 'ACADEMIC_NOT_USABLE' });
      expect(faculty.assignments).toHaveLength(2);

      // Another school's ids do not exist for this module.
      const stranger = await draftSession();
      await expect(academicService.assertSectionUsable(stranger.ctx, sectionA, { purpose: 'HISTORICAL_READ' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(academicService.assertSubjectOfferingUsable(stranger.ctx, t.o.MATH!, { purpose: 'HISTORICAL_READ' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      faculty.dispose();
    }
  });

  it('an inactive grade or subject refuses new assignments but stays readable', async () => {
    const t = await rich();
    await activate(t);
    await t.agent.patch(`${API}/subject-offerings/${t.o.ENG}`).send({ status: 'INACTIVE' }).expect(200);
    await expect(academicService.assertSubjectOfferingUsable(t.ctx, t.o.ENG!, { purpose: 'NEW_ASSIGNMENT' })).rejects.toMatchObject({ details: { reason: 'SUBJECT_INACTIVE' } });
    expect(await academicService.assertSubjectOfferingUsable(t.ctx, t.o.ENG!, { purpose: 'HISTORICAL_READ' })).toMatchObject({ subjectOffering: { subjectName: 'English' } });
    await t.agent.patch(`${API}/grade-offerings/${t.gradeOfferingId}`).send({ status: 'INACTIVE' }).expect(200);
    await expect(academicService.assertSectionUsable(t.ctx, t.sectionIds[0]!, { purpose: 'NEW_ASSIGNMENT' })).rejects.toMatchObject({ details: { reason: 'GRADE_INACTIVE' } });
  });

  it('Module 1 setup overview: Academic Structure is upcoming, then pending while only drafts exist, then completed once a session is active', async () => {
    const t = await draftSession(); // a draft session already exists
    const itemStatus = async () => {
      const res = await t.agent.get(`${API}/schools/${t.school.schoolId}/setup-status`).expect(200);
      return (res.body.data.items as { key: string; status: string }[]).find((i) => i.key === 'academic_structure')!.status;
    };
    expect(await itemStatus()).toBe('pending');
    await t.agent.delete(t.sessionUrl).expect(204);
    expect(await itemStatus()).toBe('upcoming');

    const again = await draftSession();
    await makePublishable(again);
    await act(again, 'publish').expect(200);
    const pendingStatus = (await again.agent.get(`${API}/schools/${again.school.schoolId}/setup-status`).expect(200)).body.data.items.find((i: { key: string }) => i.key === 'academic_structure').status;
    expect(pendingStatus).toBe('pending');
    await act(again, 'activate').expect(200);
    const doneRes = await again.agent.get(`${API}/schools/${again.school.schoolId}/setup-status`).expect(200);
    expect(doneRes.body.data.items.find((i: { key: string }) => i.key === 'academic_structure').status).toBe('completed');
    expect(doneRes.body.data.completionPercent).toBeGreaterThan(0);
  });
});

describe('audit trail for rules and lifecycle (AS-17)', () => {
  it('QA 24: groups, constraints, programmes and every lifecycle move leave audit rows with old and new values', async () => {
    const t = await rich();
    await t.agent.patch(`${API}/choice-groups/${t.groupId}`).send({ name: 'Electives 2', status: 'INACTIVE' }).expect(200);
    await t.agent.patch(`${API}/academic-programmes/${t.programmeId}`).send({ name: 'Track 6' }).expect(200);
    await t.agent.delete(`${API}/constraints/${t.constraintId}`).expect(204);
    await t.agent.patch(`${API}/choice-groups/${t.groupId}`).send({ status: 'ACTIVE' }).expect(200);
    await activate(t);
    await act(t, 'close').expect(200);
    await act(t, 'archive').expect(200);

    const events = await auditForSession(t.agent, t.id);
    const actions = new Set(events.map((e) => e.action));
    for (const action of [
      'choice_group.created', 'choice_group.updated', 'constraint.created', 'constraint.deleted', 'programme.created', 'programme.updated',
      'academic_session.published', 'academic_session.activated', 'academic_session.closed', 'academic_session.archived',
    ]) expect(actions, action).toContain(action);

    const by = (action: string) => events.filter((e) => e.action === action);
    expect(by('choice_group.updated')[1]!.changes).toEqual(expect.arrayContaining([{ field: 'name', from: 'Electives', to: 'Electives 2' }, { field: 'status', from: 'ACTIVE', to: 'INACTIVE' }]));
    expect(by('programme.updated')[0]!.changes).toEqual([{ field: 'name', from: 'Grade 6 track', to: 'Track 6' }]);
    expect(by('constraint.deleted')[0]!.changes).toEqual([{ field: 'rule', from: 'Science requires English', to: null }]);
    expect(by('academic_session.published')[0]).toMatchObject({ entityType: 'academic_session', changes: [{ field: 'status', from: 'DRAFT', to: 'PUBLISHED' }], actor: { role: 'SCHOOL_ADMIN' } });
    expect(by('academic_session.published')[0]!.metadata).toMatchObject({ validation: { errors: 0 } });
    expect(by('academic_session.activated')[0]!.changes).toEqual([{ field: 'status', from: 'PUBLISHED', to: 'ACTIVE' }]);
    expect(by('academic_session.archived')[0]!.changes).toEqual([{ field: 'status', from: 'CLOSED', to: 'ARCHIVED' }]);
  });

  it('refused lifecycle calls leave no audit row', async () => {
    const t = await draftSession();
    const before = (await auditForSession(t.agent, t.id)).length;
    await act(t, 'publish').expect(400);
    await act(t, 'activate').expect(409);
    expect((await auditForSession(t.agent, t.id)).length).toBe(before);
  });
});

describe('the PRD §23 demo dataset', () => {
  it('seeds Greenfield with an ACTIVE 2026-27 session, a cloned DRAFT 2027-28, and a full academic context', async () => {
    await seedDemo({ quiet: true });
    const admin = request.agent(app);
    await admin.post(`${API}/auth/login`).send({ email: 'admin@greenfield.demo', password: 'Welcome@123' }).expect(200);

    const sessions = (await admin.get(`${API}/academic-sessions`).expect(200)).body.data as AcademicSessionDTO[];
    expect(sessions.map((s) => `${s.code}:${s.status}`)).toEqual(['2027-28:DRAFT', '2026-27:ACTIVE']);
    const active = sessions.find((s) => s.status === 'ACTIVE')!;
    const next = sessions.find((s) => s.status === 'DRAFT')!;
    expect(active.locations.map((l) => `${l.locationCode}:${l.boardCode}`)).toEqual(['MOH:CBSE', 'CHD:STATE_TEST']);
    expect(next.previousSessionId).toBe(active.academicSessionId);

    const [moh, chd] = active.locations.map((l) => l.locationId) as [string, string];
    const grades = (await admin.get(`${API}/grades`).expect(200)).body.data as { gradeId: string; canonicalCode: string }[];
    const gradeId = (code: string) => grades.find((g) => g.canonicalCode === code)!.gradeId;
    const context = async (locationId: string, extra: Record<string, string> = {}) =>
      (await admin.get(`${API}/academic-context`).query({ academicSessionId: active.academicSessionId, locationId, ...extra }).expect(200)).body.data;

    expect((await context(moh)).grades).toHaveLength(14); // Nursery–XII
    expect((await context(chd)).grades).toHaveLength(10); // Nursery–VIII
    for (const location of [moh, chd]) expect((await context(location, { gradeId: gradeId('G08') })).sections.map((s: { sectionCode: string }) => s.sectionCode)).toEqual(['A', 'B', 'C']);

    const g6 = (await context(moh, { gradeId: gradeId('G06') })) as AcademicContextDTO;
    expect(g6.choiceGroups.map((g) => `${g.name}: ${g.summary}`)).toEqual([
      'Core: Take all of Mathematics, Science, Social Science, Physical Education',
      'Language 1: Choose 1 of Punjabi, Hindi, Urdu',
      'Language 2: Take all of English',
    ]);
    const g11 = (await context(moh, { gradeId: gradeId('G11') })) as AcademicContextDTO;
    expect(g11.programmes.map((p) => p.name).sort()).toEqual(['Commerce', 'Flexible Combination', 'Humanities', 'Science']);
    expect(g11.subjectOfferings.find((s) => s.subjectCode === 'PHY')?.boardSubjectCode).toBe('042');
    expect(g11.terms.map((t) => t.code)).toEqual(['T1', 'T2']);

    // The seed passes its own validation, and the cloned draft is a clean plan too.
    expect(((await admin.post(`${API}/academic-sessions/${active.academicSessionId}/validate`).expect(200)).body.data as ValidationResultDTO).summary.errors).toBe(0);
    expect(((await admin.post(`${API}/academic-sessions/${next.academicSessionId}/validate`).expect(200)).body.data as ValidationResultDTO).summary.errors).toBe(0);

    // Riverside has no academic data, and cannot see Greenfield's.
    const riverside = request.agent(app);
    await riverside.post(`${API}/auth/login`).send({ email: 'admin@riverside.demo', password: 'Welcome@123' }).expect(200);
    expect((await riverside.get(`${API}/academic-sessions`).expect(200)).body.data).toEqual([]);
    expectError(await riverside.get(`${API}/academic-sessions/${active.academicSessionId}`), 404, 'NOT_FOUND');
  }, 120_000);
});
