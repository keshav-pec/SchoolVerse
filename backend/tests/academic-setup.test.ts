import { beforeEach, describe, expect, it } from 'vitest';
import type { AcademicSessionDTO, AcademicTermDTO, BoardDTO, BoardRuleVersionDTO, GradeMasterDTO, SubjectDTO, SubjectOfferingDTO } from '@shared';
import { registerAcademicDependency, unregisterAcademicDependency } from '../src/modules/academic/dependencies';
import { GradeOffering, SectionOffering, SubjectOffering } from '../src/modules/academic/offering.model';
import { AcademicTerm } from '../src/modules/academic/session.model';
import {
  academicSchool,
  addGrades,
  API,
  auditForSession,
  createSession,
  createStarterSubjects,
  createUserAndLogin,
  expectError,
  forceStatus,
  loadReference,
  setupSchool,
  useTestDatabase,
} from './helpers';

useTestDatabase();
beforeEach(async () => {
  await loadReference();
});

/** A school with MOH (CBSE) and CHD (PSEB) in a DRAFT session, plus English, Hindi, Mathematics and Science. */
async function draftSession() {
  const s = await academicSchool();
  const session = await createSession(s.agent, [s.ref.pin(s.moh.locationId, 'CBSE'), s.ref.pin(s.chd.locationId, 'PSEB')]);
  const subjects = await createStarterSubjects(s.agent);
  const sessionUrl = `${API}/academic-sessions/${session.academicSessionId}`;
  return { ...s, session, subjects, sessionUrl, id: session.academicSessionId };
}

describe('reference data (AS-01, AS-03)', () => {
  it('seeded grades and boards are visible to every tenant and read-only', async () => {
    const a = await academicSchool('School A');
    const b = await setupSchool({ workspace: 'School B' });

    for (const agent of [a.agent, b.agent]) {
      const grades = (await agent.get(`${API}/grades`).expect(200)).body.data as GradeMasterDTO[];
      expect(grades).toHaveLength(15);
      expect(grades.map((g) => g.canonicalCode)).toEqual(['PRE_NURSERY', 'NURSERY', 'KG', ...Array.from({ length: 12 }, (_, i) => `G${String(i + 1).padStart(2, '0')}`)]);
      const stage = (code: string) => grades.find((g) => g.canonicalCode === code)!.educationStage;
      expect([stage('KG'), stage('G02'), stage('G03'), stage('G05'), stage('G06'), stage('G08'), stage('G09'), stage('G12')]).toEqual([
        'FOUNDATIONAL', 'FOUNDATIONAL', 'PREPARATORY', 'PREPARATORY', 'MIDDLE', 'MIDDLE', 'SECONDARY', 'SECONDARY',
      ]);
      expect(grades.filter((g) => g.isBoardGrade).map((g) => g.canonicalCode)).toEqual(['G10', 'G12']);
      expect(grades.filter((g) => g.isPrePrimary).map((g) => g.canonicalCode)).toEqual(['PRE_NURSERY', 'NURSERY', 'KG']);

      const boards = (await agent.get(`${API}/boards`).expect(200)).body.data as BoardDTO[];
      expect(boards.map((x) => x.boardCode).sort()).toEqual(['CBSE', 'CISCE', 'CUSTOM', 'PSEB', 'STATE_TEST']);
      expect(boards.every((x) => x.isSystem)).toBe(true);
      for (const board of boards) {
        const versions = (await agent.get(`${API}/boards/${board.boardId}/rule-versions`).expect(200)).body.data as BoardRuleVersionDTO[];
        expect(versions).toMatchObject([{ name: '2026-27', status: 'PUBLISHED', isSystem: true }]);
      }
    }

    // Read-only: no write routes exist for grades, and built-in boards refuse rule versions.
    expectError(await a.agent.post(`${API}/grades`).send({ canonicalCode: 'X' }), 404, 'ROUTE_NOT_FOUND');
    const cbse = a.ref.boardId.CBSE!;
    expectError(await a.agent.post(`${API}/boards/${cbse}/rule-versions`).send({ name: '2027-28' }), 403, 'BOARD_READ_ONLY');
    expectError(await a.agent.post(`${API}/boards/${cbse}/rule-versions/${a.ref.ruleVersionId('CBSE')}/publish`), 403, 'BOARD_READ_ONLY');
  });

  it('a school-created board and rule version are visible only to that tenant', async () => {
    const a = await academicSchool('School A');
    const b = await academicSchool('School B');

    expectError(await a.agent.post(`${API}/boards`).send({ boardCode: 'cbse', boardName: 'Clone' }), 409, 'BOARD_CODE_TAKEN');
    const board = (await a.agent.post(`${API}/boards`).send({ boardCode: 'hsb', boardName: 'Hill State Board', boardType: 'STATE' }).expect(201)).body.data as BoardDTO;
    expect(board).toMatchObject({ boardCode: 'HSB', isSystem: false });

    const draft = (await a.agent.post(`${API}/boards/${board.boardId}/rule-versions`).send({ name: '2026-27', sourceReference: 'Circular 12/2026' }).expect(201)).body.data as BoardRuleVersionDTO;
    expect(draft.status).toBe('DRAFT');

    // A draft version cannot be pinned by a session; a published one can.
    const pinTo = (ruleVersionId: string) => ({ ...a.ref.pin(a.moh.locationId), boardId: board.boardId, boardRuleVersionId: ruleVersionId });
    const body = { name: 'Y', code: 'Y1', startDate: '2026-04-01', endDate: '2027-03-31', locations: [pinTo(draft.ruleVersionId)] };
    expectError(await a.agent.post(`${API}/academic-sessions`).send(body), 400, 'RULE_VERSION_INVALID');
    const published = (await a.agent.post(`${API}/boards/${board.boardId}/rule-versions/${draft.ruleVersionId}/publish`).expect(200)).body.data as BoardRuleVersionDTO;
    expect(published.status).toBe('PUBLISHED');
    expectError(await a.agent.post(`${API}/boards/${board.boardId}/rule-versions/${draft.ruleVersionId}/publish`), 409, 'INVALID_STATUS_TRANSITION');
    await a.agent.post(`${API}/academic-sessions`).send(body).expect(201);

    // The other school never sees it, by list or by id; the same code is free for them.
    expect(((await b.agent.get(`${API}/boards`).expect(200)).body.data as BoardDTO[]).map((x) => x.boardCode)).not.toContain('HSB');
    expectError(await b.agent.get(`${API}/boards/${board.boardId}/rule-versions`), 404, 'NOT_FOUND');
    expectError(await b.agent.post(`${API}/boards/${board.boardId}/rule-versions`).send({ name: 'x' }), 404, 'NOT_FOUND');
    await b.agent.post(`${API}/boards`).send({ boardCode: 'HSB', boardName: 'Another HSB' }).expect(201);
  });
});

describe('subject master and board codes (AS-05, AS-06)', () => {
  it('QA 7: a subject keeps its identity while board codes are mapped, changed and removed', async () => {
    const { agent, ref } = await academicSchool();
    const created = (await agent.post(`${API}/subjects`).send({ subjectCode: 'math', name: 'Mathematics', category: 'MATHEMATICS' }).expect(201)).body.data as SubjectDTO;
    expect(created).toMatchObject({ subjectCode: 'MATH', status: 'ACTIVE', hasTheory: true, boardCodes: [] });
    expectError(await agent.post(`${API}/subjects`).send({ subjectCode: 'Math', name: 'Maths again', category: 'MATHEMATICS' }), 409, 'SUBJECT_CODE_TAKEN');

    const url = `${API}/subjects/${created.subjectId}`;
    await agent.put(`${url}/board-codes`).send({ boardRuleVersionId: ref.ruleVersionId('CBSE'), boardSubjectCode: '041', boardSubjectName: 'MATHEMATICS' }).expect(200);
    const mapped = (await agent.put(`${url}/board-codes`).send({ boardRuleVersionId: ref.ruleVersionId('PSEB'), boardSubjectCode: 'MT-01' }).expect(200)).body.data as SubjectDTO;
    expect(mapped.subjectId).toBe(created.subjectId);
    expect(mapped.boardCodes.map((c) => `${c.boardCode}:${c.boardSubjectCode}`)).toEqual(['CBSE:041', 'PSEB:MT-01']);

    // The official code changes; the internal subject does not.
    const remapped = (await agent.put(`${url}/board-codes`).send({ boardRuleVersionId: ref.ruleVersionId('CBSE'), boardSubjectCode: '241' }).expect(200)).body.data as SubjectDTO;
    expect(remapped.subjectId).toBe(created.subjectId);
    expect(remapped.boardCodes.find((c) => c.boardCode === 'CBSE')?.boardSubjectCode).toBe('241');

    const afterDelete = (await agent.delete(`${url}/board-codes/${ref.ruleVersionId('PSEB')}`).expect(200)).body.data as SubjectDTO;
    expect(afterDelete.boardCodes).toHaveLength(1);
    expectError(await agent.delete(`${url}/board-codes/${ref.ruleVersionId('PSEB')}`), 404, 'NOT_FOUND');

    // Subjects are never deleted, only deactivated.
    expectError(await agent.delete(url), 404, 'ROUTE_NOT_FOUND');
    const inactive = (await agent.patch(url).send({ status: 'INACTIVE', name: 'Maths' }).expect(200)).body.data as SubjectDTO;
    expect(inactive).toMatchObject({ status: 'INACTIVE', name: 'Maths', subjectId: created.subjectId });
  });

  it('filters by name or code, category, language, status, board code and grade', async () => {
    const { agent, ref, moh } = await academicSchool();
    const ids = await createStarterSubjects(agent);
    await agent.patch(`${API}/subjects/${ids.SCI}`).send({ status: 'INACTIVE' }).expect(200);
    await agent.put(`${API}/subjects/${ids.MATH}/board-codes`).send({ boardRuleVersionId: ref.ruleVersionId('CBSE'), boardSubjectCode: '041' }).expect(200);

    const list = async (query: Record<string, string>) => {
      const res = await agent.get(`${API}/subjects`).query(query).expect(200);
      return (res.body.data.items as SubjectDTO[]).map((s) => s.subjectCode);
    };
    expect(await list({})).toEqual(['ENG', 'HIN', 'MATH', 'SCI']);
    expect(await list({ search: 'math' })).toEqual(['MATH']);
    expect(await list({ search: 'hi' })).toEqual(['HIN']);
    expect(await list({ category: 'LANGUAGE' })).toEqual(['ENG', 'HIN']);
    expect(await list({ languageCode: 'HI' })).toEqual(['HIN']);
    expect(await list({ status: 'INACTIVE' })).toEqual(['SCI']);
    expect(await list({ boardCode: '041' })).toEqual(['MATH']);
    expect(await list({ boardCode: 'cbse' })).toEqual(['MATH']);
    expect(await list({ boardCode: 'PSEB' })).toEqual([]);

    const session = await createSession(agent, [ref.pin(moh.locationId)]);
    const [g6] = await addGrades(agent, session.academicSessionId, moh.locationId, [ref.gradeId.G06!]);
    await agent.post(`${API}/grade-offerings/${g6!.gradeOfferingId}/subjects`).send({ subjectIds: [ids.ENG, ids.MATH], offeringType: 'MANDATORY' }).expect(201);
    expect(await list({ gradeId: ref.gradeId.G06! })).toEqual(['ENG', 'MATH']);
    expect(await list({ gradeId: ref.gradeId.G07! })).toEqual([]);

    const page = await agent.get(`${API}/subjects`).query({ pageSize: '2', page: '2' }).expect(200);
    expect(page.body.data).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(page.body.data.items).toHaveLength(2);
  });
});

describe('academic sessions (AS-02)', () => {
  it('QA 1: creates a DRAFT session with explicit dates, not tied to April–March', async () => {
    const { agent, ref, moh } = await academicSchool();
    const session = await createSession(agent, [ref.pin(moh.locationId, 'CBSE', { affiliationNumber: '1630457' })], {
      name: 'Academic Year 2026-27 (July start)',
      startDate: '2026-07-01',
      endDate: '2027-06-30',
    });
    expect(session).toMatchObject({
      code: '2026-27',
      status: 'DRAFT',
      isCurrent: false,
      deletable: true,
      startDate: '2026-07-01',
      endDate: '2027-06-30',
      warnings: [],
      lastValidation: null,
      locations: [{ locationCode: 'MOH', boardCode: 'CBSE', ruleVersionName: '2026-27', affiliationNumber: '1630457' }],
    });

    const body = (overrides: Record<string, unknown>) => ({ name: 'Other', code: 'OTHER', startDate: '2028-04-01', endDate: '2029-03-31', locations: [], ...overrides });
    expectError(await agent.post(`${API}/academic-sessions`).send(body({ startDate: '2028-04-01', endDate: '2028-04-01' })), 400, 'SESSION_DATES_INVALID');
    expectError(await agent.post(`${API}/academic-sessions`).send(body({ startDate: '2029-04-01', endDate: '2028-04-01' })), 400, 'SESSION_DATES_INVALID');
    expect(expectError(await agent.post(`${API}/academic-sessions`).send(body({ startDate: '2028-02-30' })), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('startDate');
    expectError(await agent.post(`${API}/academic-sessions`).send(body({ code: '2026-27' })), 409, 'SESSION_CODE_TAKEN');
    // Codes are stored upper-cased, so a different case collides too.
    await agent.post(`${API}/academic-sessions`).send(body({ code: 'fy28' })).expect(201);
    expectError(await agent.post(`${API}/academic-sessions`).send(body({ code: 'FY28' })), 409, 'SESSION_CODE_TAKEN');

    const list = (await agent.get(`${API}/academic-sessions`).expect(200)).body.data as AcademicSessionDTO[];
    expect(list.map((s) => s.code)).toEqual(['FY28', '2026-27']); // newest first
    expect((await agent.get(`${API}/academic-sessions`).query({ status: 'ACTIVE' }).expect(200)).body.data).toEqual([]);
  });

  it('QA 3: starts with one location and grows to many; only ACTIVE locations with a published rule version are accepted', async () => {
    const { agent, ref, moh, chd, pkl } = await academicSchool();
    const session = await createSession(agent, [ref.pin(moh.locationId)]);
    const url = `${API}/academic-sessions/${session.academicSessionId}`;
    expect(session.locations).toHaveLength(1);

    const two = (await agent.patch(url).send({ locations: [ref.pin(moh.locationId), ref.pin(chd.locationId, 'PSEB')] }).expect(200)).body.data as AcademicSessionDTO;
    expect(two.locations.map((l) => `${l.locationCode}:${l.boardCode}`)).toEqual(['MOH:CBSE', 'CHD:PSEB']);

    expectError(await agent.patch(url).send({ locations: [ref.pin(moh.locationId), ref.pin(pkl.locationId)] }), 409, 'LOCATION_NOT_ACTIVE'); // draft campus
    expectError(await agent.patch(url).send({ locations: [ref.pin(moh.locationId), ref.pin(moh.locationId)] }), 400, 'VALIDATION_FAILED'); // repeated
    // A rule version of another board.
    expectError(
      await agent.patch(url).send({ locations: [{ ...ref.pin(moh.locationId, 'CBSE'), boardRuleVersionId: ref.ruleVersionId('PSEB') }] }),
      400,
      'RULE_VERSION_INVALID',
    );
    // Nothing above changed the session.
    expect(((await agent.get(url).expect(200)).body.data as AcademicSessionDTO).locations).toHaveLength(2);

    // Renaming still works if a location is deactivated later: unchanged entries are not re-checked.
    await agent.post(`${API}/locations/${chd.locationId}/deactivate`).expect(200);
    const renamed = (await agent.patch(url).send({ name: 'Renamed', locations: two.locations.map((l) => ({ locationId: l.locationId, boardId: l.boardId, boardRuleVersionId: l.boardRuleVersionId })) }).expect(200)).body.data;
    expect(renamed.name).toBe('Renamed');
  });

  it('overlapping dates produce a warning, not an error', async () => {
    const { agent } = await academicSchool();
    const a = await createSession(agent, [], { code: 'SA', startDate: '2026-04-01', endDate: '2027-03-31' });
    const b = await createSession(agent, [], { code: 'SB', startDate: '2026-10-01', endDate: '2027-09-30' });
    expect(b.warnings).toMatchObject([{ code: 'SESSION_DATES_OVERLAP', academicSessionId: a.academicSessionId }]);
    const reread = (await agent.get(`${API}/academic-sessions/${a.academicSessionId}`).expect(200)).body.data as AcademicSessionDTO;
    expect(reread.warnings).toMatchObject([{ academicSessionId: b.academicSessionId }]);
    const clear = await createSession(agent, [], { code: 'SC', startDate: '2028-04-01', endDate: '2029-03-31' });
    expect(clear.warnings).toEqual([]);
  });

  it('a location cannot be removed once grades or terms exist for it, nor change rule version under linked board codes', async () => {
    const t = await draftSession();
    const [g] = await addGrades(t.agent, t.id, t.chd.locationId, [t.ref.gradeId.G08!]);
    const keepMoh = [t.ref.pin(t.moh.locationId, 'CBSE')];

    const blocked = expectError(await t.agent.patch(t.sessionUrl).send({ locations: keepMoh }), 409, 'ACADEMIC_HAS_DEPENDENCIES');
    expect(blocked.details.dependencies).toMatchObject([{ key: 'academic.grade_offerings', count: 1 }]);
    await t.agent.delete(`${API}/grade-offerings/${g!.gradeOfferingId}`).expect(204);

    await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'CHD term', code: 'C1', locationId: t.chd.locationId, startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201);
    expect(expectError(await t.agent.patch(t.sessionUrl).send({ locations: keepMoh }), 409, 'ACADEMIC_HAS_DEPENDENCIES').details.dependencies).toMatchObject([{ key: 'academic.terms' }]);
    const term = (await t.agent.get(`${t.sessionUrl}/terms`).expect(200)).body.data[0] as AcademicTermDTO;
    await t.agent.delete(`${API}/terms/${term.termId}`).expect(204);
    expect(((await t.agent.patch(t.sessionUrl).send({ locations: keepMoh }).expect(200)).body.data as AcademicSessionDTO).locations).toHaveLength(1);

    // Linked board codes pin the rule version.
    await t.agent.put(`${API}/subjects/${t.subjects.MATH}/board-codes`).send({ boardRuleVersionId: t.ref.ruleVersionId('CBSE'), boardSubjectCode: '041' }).expect(200);
    const [g6] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G06!]);
    await t.agent.post(`${API}/grade-offerings/${g6!.gradeOfferingId}/subjects`).send({ subjectIds: [t.subjects.MATH], offeringType: 'MANDATORY' }).expect(201);
    const switchBoard = [t.ref.pin(t.moh.locationId, 'CISCE')];
    expectError(await t.agent.patch(t.sessionUrl).send({ locations: switchBoard }), 409, 'ACADEMIC_HAS_DEPENDENCIES');
  });

  it('shrinking the dates below an existing term is refused', async () => {
    const t = await draftSession();
    await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'Term 2', code: 'T2', startDate: '2026-10-01', endDate: '2027-03-31' }).expect(201);
    expectError(await t.agent.patch(t.sessionUrl).send({ endDate: '2026-12-31' }), 400, 'TERM_OUTSIDE_SESSION');
    expectError(await t.agent.patch(t.sessionUrl).send({ startDate: '2027-04-01' }), 400, 'SESSION_DATES_INVALID');
    expect(((await t.agent.patch(t.sessionUrl).send({ endDate: '2027-06-30' }).expect(200)).body.data as AcademicSessionDTO).endDate).toBe('2027-06-30');
  });

  it('can only be deleted while DRAFT, and deleting takes its contents with it', async () => {
    const t = await draftSession();
    const [g] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G06!]);
    await t.agent.post(`${API}/grade-offerings/${g!.gradeOfferingId}/sections`).send({ codes: ['A'] }).expect(201);
    await t.agent.post(`${API}/grade-offerings/${g!.gradeOfferingId}/subjects`).send({ subjectIds: [t.subjects.ENG], offeringType: 'MANDATORY' }).expect(201);
    await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'Term 1', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201);

    for (const status of ['PUBLISHED', 'ACTIVE', 'CLOSED', 'ARCHIVED'] as const) {
      await forceStatus(t.tenantId, t.id, status);
      expectError(await t.agent.delete(t.sessionUrl), 409, 'SESSION_NOT_DRAFT');
    }
    await forceStatus(t.tenantId, t.id, 'DRAFT');
    await t.agent.delete(t.sessionUrl).expect(204);
    expectError(await t.agent.get(t.sessionUrl), 404, 'NOT_FOUND');
    const left = await Promise.all([GradeOffering, SectionOffering, SubjectOffering, AcademicTerm].map((m) => (m as typeof GradeOffering).countDocuments({ tenantId: t.tenantId })));
    expect(left).toEqual([0, 0, 0, 0]);
    // The code is free again.
    await createSession(t.agent, []);
  });
});

describe('grade offerings and sections (AS-03, AS-04)', () => {
  it('QA 5: adds grades in bulk with default labels, then sections in bulk', async () => {
    const t = await draftSession();
    const grades = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G03!, t.ref.gradeId.NURSERY!, t.ref.gradeId.G02!]);
    expect(grades.map((g) => g.displayName)).toEqual(['Nursery', 'Grade 2', 'Grade 3']); // master order, default labels

    const list = (await t.agent.get(`${t.sessionUrl}/grade-offerings`).query({ locationId: t.moh.locationId }).expect(200)).body.data;
    expect(list).toMatchObject([
      { displayName: 'Nursery', displayCode: 'N', canonicalCode: 'NURSERY', status: 'ACTIVE', sectionCount: 0 },
      { displayName: 'Grade 2', displayCode: '2' },
      { displayName: 'Grade 3', displayCode: '3' },
    ]);

    const g3 = grades[2]!.gradeOfferingId;
    const renamed = (await t.agent.patch(`${API}/grade-offerings/${g3}`).send({ displayName: 'Class III', displayCode: 'III', medium: 'English', capacity: 120 }).expect(200)).body.data;
    expect(renamed).toMatchObject({ displayName: 'Class III', displayCode: 'III', medium: 'English', capacity: 120 });
    expect(renamed.canonicalCode).toBe('G03'); // the master identity is untouched

    const sections = (await t.agent.post(`${API}/grade-offerings/${g3}/sections`).send({ codes: ['A', 'B', 'C'], capacity: 40 }).expect(201)).body.data;
    expect(sections.map((s: { sectionCode: string; sequenceOrder: number }) => [s.sectionCode, s.sequenceOrder])).toEqual([['A', 1], ['B', 2], ['C', 3]]);
    const more = (await t.agent.post(`${API}/grade-offerings/${g3}/sections`).send({ codes: ['d'] }).expect(201)).body.data;
    expect(more[0]).toMatchObject({ sectionCode: 'D', sequenceOrder: 4 });

    const read = (await t.agent.get(`${API}/grade-offerings/${g3}/sections`).expect(200)).body.data;
    expect(read.map((s: { sectionCode: string }) => s.sectionCode)).toEqual(['A', 'B', 'C', 'D']);
    expect((await t.agent.get(`${API}/grade-offerings/${g3}`).expect(200)).body.data.sectionCount).toBe(4);

    const section = read[0];
    const patched = (await t.agent.patch(`${API}/sections/${section.sectionOfferingId}`).send({ displayName: 'Rose', capacity: 35 }).expect(200)).body.data;
    expect(patched).toMatchObject({ displayName: 'Rose', capacity: 35, sectionCode: 'A' });
  });

  it('QA 4: the same grade can be set up differently at two locations', async () => {
    const t = await draftSession();
    const [moh] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G08!], { medium: 'English' });
    const [chd] = await addGrades(t.agent, t.id, t.chd.locationId, [t.ref.gradeId.G08!], { medium: 'Punjabi' });
    expect(moh!.gradeOfferingId).not.toBe(chd!.gradeOfferingId);
    await t.agent.patch(`${API}/grade-offerings/${chd!.gradeOfferingId}`).send({ displayName: 'Standard 8', capacity: 30 }).expect(200);

    const all = (await t.agent.get(`${t.sessionUrl}/grade-offerings`).expect(200)).body.data as { locationId: string; displayName: string; medium: string; capacity: number | null }[];
    expect(all.find((g) => g.locationId === t.moh.locationId)).toMatchObject({ displayName: 'Grade 8', medium: 'English', capacity: null });
    expect(all.find((g) => g.locationId === t.chd.locationId)).toMatchObject({ displayName: 'Standard 8', medium: 'Punjabi', capacity: 30 });

    // …but the same grade cannot be added twice at one location, and the location must be in the session.
    const dup = expectError(
      await t.agent.post(`${t.sessionUrl}/grade-offerings`).send({ locationId: t.moh.locationId, gradeIds: [t.ref.gradeId.G07!, t.ref.gradeId.G08!] }),
      409,
      'GRADE_OFFERING_EXISTS',
    );
    expect(dup.details.gradeIds).toEqual([t.ref.gradeId.G08]);
    expect(await GradeOffering.countDocuments({ tenantId: t.tenantId, locationId: t.moh.locationId })).toBe(1); // G07 not added either
    expectError(await t.agent.post(`${t.sessionUrl}/grade-offerings`).send({ locationId: t.pkl.locationId, gradeIds: [t.ref.gradeId.G08!] }), 409, 'LOCATION_NOT_IN_SESSION');
    expectError(await t.agent.post(`${t.sessionUrl}/grade-offerings`).send({ locationId: t.moh.locationId, gradeIds: [] }), 400, 'VALIDATION_FAILED');
  });

  it('QA 6: a duplicate section is blocked, in any letter case, but other grades may reuse the code', async () => {
    const t = await draftSession();
    const [moh] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G08!]);
    const [chd] = await addGrades(t.agent, t.id, t.chd.locationId, [t.ref.gradeId.G08!]);
    const url = (id: string) => `${API}/grade-offerings/${id}/sections`;

    await t.agent.post(url(moh!.gradeOfferingId)).send({ codes: ['A', 'B'] }).expect(201);
    expectError(await t.agent.post(url(moh!.gradeOfferingId)).send({ codes: ['a'] }), 409, 'SECTION_CODE_TAKEN');
    const clash = expectError(await t.agent.post(url(moh!.gradeOfferingId)).send({ codes: ['C', 'b'] }), 409, 'SECTION_CODE_TAKEN');
    expect(clash.details.codes).toEqual(['B']);
    expectError(await t.agent.post(url(moh!.gradeOfferingId)).send({ codes: ['X', 'x'] }), 409, 'SECTION_CODE_TAKEN'); // repeated in the request
    expect((await t.agent.get(url(moh!.gradeOfferingId)).expect(200)).body.data).toHaveLength(2); // the failed requests added nothing

    // Mohali VIII-A and Chandigarh VIII-A never collide.
    await t.agent.post(url(chd!.gradeOfferingId)).send({ codes: ['A'] }).expect(201);
    expect(expectError(await t.agent.post(url(moh!.gradeOfferingId)).send({ codes: ['??'] }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('codes.0');
  });
});

describe('subject offerings (AS-07)', () => {
  it('QA 8: offers mandatory and elective subjects, once each, and only active subjects', async () => {
    const t = await draftSession();
    const [g] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G06!]);
    const url = `${API}/grade-offerings/${g!.gradeOfferingId}/subjects`;

    const core = (await t.agent.post(url).send({ subjectIds: [t.subjects.MATH, t.subjects.SCI], offeringType: 'MANDATORY' }).expect(201)).body.data as SubjectOfferingDTO[];
    expect(core.map((o) => o.subjectCode).sort()).toEqual(['MATH', 'SCI']);
    const elective = (await t.agent.post(url).send({ subjectIds: [t.subjects.HIN], offeringType: 'ELECTIVE' }).expect(201)).body.data as SubjectOfferingDTO[];
    expect(elective[0]).toMatchObject({ subjectCode: 'HIN', offeringType: 'ELECTIVE', status: 'ACTIVE', boardSubjectCode: null });

    const listed = (await t.agent.get(url).expect(200)).body.data as SubjectOfferingDTO[];
    expect(listed.map((o) => `${o.subjectCode}:${o.offeringType}`)).toEqual(['HIN:ELECTIVE', 'MATH:MANDATORY', 'SCI:MANDATORY']);
    expect((await t.agent.get(`${API}/grade-offerings/${g!.gradeOfferingId}`).expect(200)).body.data.subjectCount).toBe(3);

    expectError(await t.agent.post(url).send({ subjectIds: [t.subjects.ENG, t.subjects.MATH], offeringType: 'MANDATORY' }), 409, 'SUBJECT_ALREADY_OFFERED');
    expect(await SubjectOffering.countDocuments({ tenantId: t.tenantId })).toBe(3); // ENG was not added by the failed request

    await t.agent.patch(`${API}/subjects/${t.subjects.ENG}`).send({ status: 'INACTIVE' }).expect(200);
    expectError(await t.agent.post(url).send({ subjectIds: [t.subjects.ENG], offeringType: 'MANDATORY' }), 409, 'SUBJECT_INACTIVE');
    expectError(await t.agent.post(url).send({ subjectIds: ['6f0b3e0a-1f2e-4d5b-8c1a-0a1b2c3d4e5f'], offeringType: 'MANDATORY' }), 404, 'NOT_FOUND');

    const changed = (await t.agent.patch(`${API}/subject-offerings/${elective[0]!.subjectOfferingId}`).send({ offeringType: 'LANGUAGE' }).expect(200)).body.data;
    expect(changed.offeringType).toBe('LANGUAGE');
  });

  it('board mappings follow the location rule version and must belong to it', async () => {
    const t = await draftSession();
    const code = (subjectId: string, ruleVersion: string, boardSubjectCode: string) =>
      t.agent.put(`${API}/subjects/${subjectId}/board-codes`).send({ boardRuleVersionId: t.ref.ruleVersionId(ruleVersion), boardSubjectCode }).expect(200);
    await code(t.subjects.MATH!, 'CBSE', '041');
    const withPseb = (await code(t.subjects.MATH!, 'PSEB', 'M-1')).body.data as SubjectDTO;
    await code(t.subjects.SCI!, 'CBSE', '086');

    const [g] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G06!]); // MOH follows CBSE
    const url = `${API}/grade-offerings/${g!.gradeOfferingId}/subjects`;
    const [math, hin] = (await t.agent.post(url).send({ subjectIds: [t.subjects.MATH, t.subjects.HIN], offeringType: 'MANDATORY' }).expect(201)).body.data.sort((a: SubjectOfferingDTO) => (a.subjectCode === 'MATH' ? -1 : 1)) as SubjectOfferingDTO[];
    expect(math).toMatchObject({ subjectCode: 'MATH', boardSubjectCode: '041' }); // linked on its own
    expect(hin).toMatchObject({ subjectCode: 'HIN', boardSubjectCode: null });

    const psebDefinition = withPseb.boardCodes.find((c) => c.boardCode === 'PSEB')!.definitionId;
    const cbseDefinition = withPseb.boardCodes.find((c) => c.boardCode === 'CBSE')!.definitionId;
    const patch = (offeringId: string, boardSubjectDefinitionId: string | null) => t.agent.patch(`${API}/subject-offerings/${offeringId}`).send({ boardSubjectDefinitionId });
    expectError(await patch(math!.subjectOfferingId, psebDefinition), 400, 'BOARD_MAPPING_INVALID'); // wrong rule version
    const sciDefinition = (await t.agent.get(`${API}/subjects/${t.subjects.SCI}`).expect(200)).body.data.boardCodes[0].definitionId as string;
    expectError(await patch(math!.subjectOfferingId, sciDefinition), 400, 'BOARD_MAPPING_INVALID'); // another subject's code
    expectError(await patch(math!.subjectOfferingId, '6f0b3e0a-1f2e-4d5b-8c1a-0a1b2c3d4e5f'), 400, 'BOARD_MAPPING_INVALID');

    // A mapping in use cannot be removed until it is unlinked.
    expectError(await t.agent.delete(`${API}/subjects/${t.subjects.MATH}/board-codes/${t.ref.ruleVersionId('CBSE')}`), 409, 'ACADEMIC_HAS_DEPENDENCIES');
    expect((await patch(math!.subjectOfferingId, null).expect(200)).body.data.boardSubjectCode).toBeNull();
    expect((await patch(math!.subjectOfferingId, cbseDefinition).expect(200)).body.data.boardSubjectCode).toBe('041');
    await patch(math!.subjectOfferingId, null).expect(200);
    await t.agent.delete(`${API}/subjects/${t.subjects.MATH}/board-codes/${t.ref.ruleVersionId('CBSE')}`).expect(200);
  });

  it('copies a subject list only when asked, skipping what is already there', async () => {
    const t = await draftSession();
    const [g6, g7] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G06!, t.ref.gradeId.G07!]);
    const [chd8] = await addGrades(t.agent, t.id, t.chd.locationId, [t.ref.gradeId.G08!]);
    await t.agent.post(`${API}/grade-offerings/${g6!.gradeOfferingId}/subjects`).send({ subjectIds: [t.subjects.MATH, t.subjects.SCI], offeringType: 'MANDATORY' }).expect(201);
    await t.agent.post(`${API}/grade-offerings/${g6!.gradeOfferingId}/subjects`).send({ subjectIds: [t.subjects.HIN], offeringType: 'ELECTIVE' }).expect(201);
    expect((await t.agent.get(`${API}/grade-offerings/${g7!.gradeOfferingId}/subjects`).expect(200)).body.data).toEqual([]); // nothing is copied automatically

    const copyUrl = (to: string, from: string) => `${API}/grade-offerings/${to}/subjects/copy-from/${from}`;
    await t.agent.post(`${API}/grade-offerings/${g7!.gradeOfferingId}/subjects`).send({ subjectIds: [t.subjects.SCI], offeringType: 'MANDATORY' }).expect(201);
    const first = (await t.agent.post(copyUrl(g7!.gradeOfferingId, g6!.gradeOfferingId)).expect(201)).body.data;
    expect(first.created.map((o: SubjectOfferingDTO) => `${o.subjectCode}:${o.offeringType}`).sort()).toEqual(['HIN:ELECTIVE', 'MATH:MANDATORY']);
    expect(first.skipped).toBe(1);
    expect((await t.agent.post(copyUrl(g7!.gradeOfferingId, g6!.gradeOfferingId)).expect(201)).body.data).toMatchObject({ created: [], skipped: 3 });

    expect(expectError(await t.agent.post(copyUrl(g7!.gradeOfferingId, g7!.gradeOfferingId)), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('sourceGradeOfferingId');
    // Another session's grade is out of reach.
    const other = await createSession(t.agent, [t.ref.pin(t.moh.locationId)], { code: 'NEXT', startDate: '2027-04-01', endDate: '2028-03-31' });
    const [otherG] = await addGrades(t.agent, other.academicSessionId, t.moh.locationId, [t.ref.gradeId.G06!]);
    expect(expectError(await t.agent.post(copyUrl(g7!.gradeOfferingId, otherG!.gradeOfferingId)), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('sourceGradeOfferingId');
    expect((await t.agent.post(copyUrl(chd8!.gradeOfferingId, g6!.gradeOfferingId)).expect(201)).body.data.created).toHaveLength(3); // other location, same session: fine
  });
});

describe('terms (AS-12)', () => {
  const term = (overrides: Record<string, unknown> = {}) => ({ name: 'Term 1', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30', ...overrides });

  it('QA 15: terms outside the session or overlapping each other are blocked', async () => {
    const t = await draftSession();
    const post = (body: Record<string, unknown>) => t.agent.post(`${t.sessionUrl}/terms`).send(body);

    const t1 = (await post(term()).expect(201)).body.data as AcademicTermDTO;
    expect(t1).toMatchObject({ code: 'T1', type: 'TERM', sequence: 1, locationId: null });
    expectError(await post(term({ name: 'Early', code: 'E', startDate: '2026-03-01', endDate: '2026-03-31' })), 400, 'TERM_OUTSIDE_SESSION');
    expectError(await post(term({ name: 'Late', code: 'L', startDate: '2027-03-01', endDate: '2027-04-30' })), 400, 'TERM_OUTSIDE_SESSION');
    expect(expectError(await post(term({ code: 'X', startDate: '2026-09-30', endDate: '2026-04-01' })), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('endDate');

    const overlap = expectError(await post(term({ name: 'Term 2', code: 'T2', startDate: '2026-09-30', endDate: '2027-03-31' })), 409, 'TERM_OVERLAP'); // shares one day
    expect(overlap.details.overlapsWith).toMatchObject([{ termId: t1.termId }]);
    const t2 = (await post(term({ name: 'Term 2', code: 'T2', startDate: '2026-10-01', endDate: '2027-03-31' })).expect(201)).body.data as AcademicTermDTO;
    expect(t2.sequence).toBe(2);
    expectError(await post(term({ name: 'Dup', code: 't1', startDate: '2026-04-01', endDate: '2026-04-02', locationId: null })), 409, 'TERM_OVERLAP');

    // A location-specific variant has its own scope: same dates are fine there, and only there.
    const variant = (await post(term({ name: 'Mohali Term 1', code: 'T1', locationId: t.moh.locationId, endDate: '2026-08-31' })).expect(201)).body.data as AcademicTermDTO;
    expect(variant.locationId).toBe(t.moh.locationId);
    expectError(await post(term({ name: 'Mohali again', code: 'T9', locationId: t.moh.locationId, startDate: '2026-08-31', endDate: '2026-12-31' })), 409, 'TERM_OVERLAP');
    expectError(await post(term({ code: 'T1', locationId: t.moh.locationId, startDate: '2027-01-01', endDate: '2027-01-31' })), 409, 'TERM_CODE_TAKEN');
    expectError(await post(term({ code: 'P', locationId: t.pkl.locationId })), 409, 'LOCATION_NOT_IN_SESSION');

    expect(((await t.agent.get(`${t.sessionUrl}/terms`).expect(200)).body.data as AcademicTermDTO[]).map((x) => x.code)).toEqual(['T1', 'T1', 'T2']);
    expect(((await t.agent.get(`${t.sessionUrl}/terms`).query({ locationId: t.moh.locationId }).expect(200)).body.data as AcademicTermDTO[]).map((x) => x.name)).toEqual(['Mohali Term 1']);

    // Editing is checked against the others, but a term never overlaps itself.
    expectError(await t.agent.patch(`${API}/terms/${t1.termId}`).send({ endDate: '2026-10-15' }), 409, 'TERM_OVERLAP');
    expectError(await t.agent.patch(`${API}/terms/${t1.termId}`).send({ startDate: '2026-01-01' }), 400, 'TERM_OUTSIDE_SESSION');
    const edited = (await t.agent.patch(`${API}/terms/${t1.termId}`).send({ name: 'First term', endDate: '2026-09-15' }).expect(200)).body.data;
    expect(edited).toMatchObject({ name: 'First term', endDate: '2026-09-15' });
    await t.agent.delete(`${API}/terms/${t2.termId}`).expect(204);
  });

  it('computes planned / current / closed from today’s date', async () => {
    const { agent } = await academicSchool();
    const session = await createSession(agent, [], { code: 'LONG', startDate: '2000-01-01', endDate: '2099-12-31' });
    const url = `${API}/academic-sessions/${session.academicSessionId}/terms`;
    const add = async (code: string, startDate: string, endDate: string) =>
      ((await agent.post(url).send({ name: code, code, startDate, endDate }).expect(201)).body.data as AcademicTermDTO).status;
    expect(await add('OLD', '2000-01-01', '2001-12-31')).toBe('closed');
    expect(await add('NOW', '2002-01-01', '2098-12-31')).toBe('current');
    expect(await add('NEXT', '2099-01-01', '2099-12-31')).toBe('planned');
    expect(((await agent.get(url).expect(200)).body.data as AcademicTermDTO[]).map((x) => x.status)).toEqual(['closed', 'current', 'planned']);
  });
});

describe('session status rules (edit guard)', () => {
  it('ACTIVE allows additive changes; removing structure is blocked only when something depends on it and never deletes', async () => {
    const t = await draftSession();
    const [g6] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G06!]);
    const [section] = (await t.agent.post(`${API}/grade-offerings/${g6!.gradeOfferingId}/sections`).send({ codes: ['A'] }).expect(201)).body.data;
    await forceStatus(t.tenantId, t.id, 'ACTIVE');

    // Additive and display edits are fine.
    await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G07!]);
    await t.agent.post(`${API}/grade-offerings/${g6!.gradeOfferingId}/sections`).send({ codes: ['B'] }).expect(201);
    await t.agent.patch(`${API}/grade-offerings/${g6!.gradeOfferingId}`).send({ displayName: 'Class VI' }).expect(200);
    await t.agent.patch(t.sessionUrl).send({ name: 'Renamed while active' }).expect(200);

    // Hard delete is never offered once the session is past DRAFT.
    expectError(await t.agent.delete(`${API}/sections/${section.sectionOfferingId}`), 409, 'USE_DEACTIVATE_INSTEAD');
    expectError(await t.agent.delete(`${API}/grade-offerings/${g6!.gradeOfferingId}`), 409, 'USE_DEACTIVATE_INSTEAD');

    // A downstream module (here a stub) says the section is in use → deactivating it is refused.
    registerAcademicDependency({
      key: 'test.faculty-assignments',
      label: 'Faculty assignments',
      entityTypes: ['section_offering', 'grade_offering'],
      count: async ({ entityId }) => (entityId === section.sectionOfferingId ? 2 : 0),
      message: (n) => `${n} faculty assignments use this section.`,
    });
    try {
      const err = expectError(await t.agent.patch(`${API}/sections/${section.sectionOfferingId}`).send({ status: 'INACTIVE' }), 409, 'ACADEMIC_HAS_DEPENDENCIES');
      expect(err.details.dependencies).toMatchObject([{ key: 'test.faculty-assignments', count: 2 }]);
      await t.agent.patch(`${API}/sections/${section.sectionOfferingId}`).send({ displayName: 'Section A' }).expect(200); // display edit still fine
    } finally {
      unregisterAcademicDependency('test.faculty-assignments');
    }
    expect((await t.agent.patch(`${API}/sections/${section.sectionOfferingId}`).send({ status: 'INACTIVE' }).expect(200)).body.data.status).toBe('INACTIVE');
    expect((await t.agent.patch(`${API}/grade-offerings/${g6!.gradeOfferingId}`).send({ status: 'INACTIVE' }).expect(200)).body.data.status).toBe('INACTIVE');
  });

  it('PUBLISHED can still be reshaped, including deletes of offerings, since nobody has used it', async () => {
    const t = await draftSession();
    await forceStatus(t.tenantId, t.id, 'PUBLISHED');
    const [g] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G06!]);
    // Delete policy: hard delete only while DRAFT; a published session deactivates instead.
    expectError(await t.agent.delete(`${API}/grade-offerings/${g!.gradeOfferingId}`), 409, 'USE_DEACTIVATE_INSTEAD');
    await t.agent.patch(`${API}/grade-offerings/${g!.gradeOfferingId}`).send({ status: 'INACTIVE' }).expect(200);
    const term = (await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'T', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201)).body.data;
    await t.agent.delete(`${API}/terms/${term.termId}`).expect(204);
  });

  it('QA 18 (part): CLOSED and ARCHIVED sessions stay readable but every change is refused', async () => {
    const t = await draftSession();
    const [g] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G06!]);
    const [section] = (await t.agent.post(`${API}/grade-offerings/${g!.gradeOfferingId}/sections`).send({ codes: ['A'] }).expect(201)).body.data;
    const [offering] = (await t.agent.post(`${API}/grade-offerings/${g!.gradeOfferingId}/subjects`).send({ subjectIds: [t.subjects.ENG], offeringType: 'MANDATORY' }).expect(201)).body.data;
    const term = (await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'T', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201)).body.data;

    for (const status of ['CLOSED', 'ARCHIVED'] as const) {
      await forceStatus(t.tenantId, t.id, status);
      const refused = [
        t.agent.patch(t.sessionUrl).send({ name: 'x' }),
        t.agent.post(`${t.sessionUrl}/grade-offerings`).send({ locationId: t.moh.locationId, gradeIds: [t.ref.gradeId.G07!] }),
        t.agent.patch(`${API}/grade-offerings/${g!.gradeOfferingId}`).send({ displayName: 'x' }),
        t.agent.delete(`${API}/grade-offerings/${g!.gradeOfferingId}`),
        t.agent.post(`${API}/grade-offerings/${g!.gradeOfferingId}/sections`).send({ codes: ['Z'] }),
        t.agent.patch(`${API}/sections/${section.sectionOfferingId}`).send({ displayName: 'x' }),
        t.agent.delete(`${API}/sections/${section.sectionOfferingId}`),
        t.agent.post(`${API}/grade-offerings/${g!.gradeOfferingId}/subjects`).send({ subjectIds: [t.subjects.HIN], offeringType: 'MANDATORY' }),
        t.agent.patch(`${API}/subject-offerings/${offering.subjectOfferingId}`).send({ offeringType: 'ELECTIVE' }),
        t.agent.delete(`${API}/subject-offerings/${offering.subjectOfferingId}`),
        t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'T2', code: 'T2', startDate: '2026-10-01', endDate: '2026-12-31' }),
        t.agent.patch(`${API}/terms/${term.termId}`).send({ name: 'x' }),
        t.agent.delete(`${API}/terms/${term.termId}`),
      ];
      for (const [i, res] of (await Promise.all(refused)).entries()) {
        expect(res.status, `${status} call #${i}: ${JSON.stringify(res.body)}`).toBe(409);
        expect(res.body.error.code, `${status} call #${i}`).toBe('SESSION_READ_ONLY');
      }
      // Still fully readable.
      expect((await t.agent.get(t.sessionUrl).expect(200)).body.data.status).toBe(status);
      expect((await t.agent.get(`${t.sessionUrl}/grade-offerings`).expect(200)).body.data).toHaveLength(1);
      expect((await t.agent.get(`${API}/grade-offerings/${g!.gradeOfferingId}/subjects`).expect(200)).body.data).toHaveLength(1);
      expect((await t.agent.get(`${t.sessionUrl}/terms`).expect(200)).body.data).toHaveLength(1);
    }
  });
});

describe('location dependency (Module 1 registry)', () => {
  it('a location with grade offerings in a non-closed session cannot be archived', async () => {
    const t = await draftSession();
    await addGrades(t.agent, t.id, t.chd.locationId, [t.ref.gradeId.G06!]);
    await t.agent.post(`${API}/locations/${t.chd.locationId}/deactivate`).expect(200);

    const blocked = expectError(await t.agent.post(`${API}/locations/${t.chd.locationId}/archive`), 409, 'LOCATION_HAS_DEPENDENCIES');
    expect(blocked.details.dependencies).toMatchObject([{ key: 'academic.structure', label: 'Academic structure', count: 1 }]);
    // The code is locked and the location cannot be deleted once a session has used it.
    expectError(await t.agent.patch(`${API}/locations/${t.chd.locationId}`).send({ locationCode: 'CHD2' }), 409, 'LOCATION_CODE_LOCKED');

    await forceStatus(t.tenantId, t.id, 'CLOSED');
    await t.agent.post(`${API}/locations/${t.chd.locationId}/archive`).expect(200);
  });

  it('a location used by a session without grades is not blocked from archiving, but the session keeps its code locked', async () => {
    const t = await draftSession();
    await t.agent.post(`${API}/locations/${t.chd.locationId}/deactivate`).expect(200);
    expectError(await t.agent.patch(`${API}/locations/${t.chd.locationId}`).send({ locationCode: 'CHD2' }), 409, 'LOCATION_CODE_LOCKED');
    await t.agent.post(`${API}/locations/${t.chd.locationId}/archive`).expect(200);
  });
});

describe('audit trail (AS-17)', () => {
  it('every mutation writes an audit row with field-level changes, grouped by session', async () => {
    const t = await draftSession();
    const [g] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G08!]);
    await t.agent.patch(`${API}/grade-offerings/${g!.gradeOfferingId}`).send({ displayName: 'Class VIII', capacity: 90 }).expect(200);
    const [section] = (await t.agent.post(`${API}/grade-offerings/${g!.gradeOfferingId}/sections`).send({ codes: ['A'] }).expect(201)).body.data;
    await t.agent.patch(`${API}/sections/${section.sectionOfferingId}`).send({ capacity: 40 }).expect(200);
    const [offering] = (await t.agent.post(`${API}/grade-offerings/${g!.gradeOfferingId}/subjects`).send({ subjectIds: [t.subjects.MATH], offeringType: 'MANDATORY' }).expect(201)).body.data;
    await t.agent.patch(`${API}/subject-offerings/${offering.subjectOfferingId}`).send({ offeringType: 'ELECTIVE' }).expect(200);
    const term = (await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'Term 1', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201)).body.data;
    await t.agent.patch(`${API}/terms/${term.termId}`).send({ endDate: '2026-09-15' }).expect(200);
    await t.agent.patch(t.sessionUrl).send({ name: 'AY 26-27' }).expect(200);
    await t.agent.delete(`${API}/terms/${term.termId}`).expect(204);
    await t.agent.delete(`${API}/subject-offerings/${offering.subjectOfferingId}`).expect(204);
    await t.agent.delete(`${API}/sections/${section.sectionOfferingId}`).expect(204);
    await t.agent.delete(`${API}/grade-offerings/${g!.gradeOfferingId}`).expect(204);

    const events = await auditForSession(t.agent, t.id);
    const actions = events.map((e) => e.action);
    expect(actions.sort()).toEqual(
      [
        'academic_session.created',
        'academic_session.updated',
        'grade_offering.created',
        'grade_offering.updated',
        'grade_offering.deleted',
        'section.created',
        'section.updated',
        'section.deleted',
        'subject_offering.created',
        'subject_offering.updated',
        'subject_offering.deleted',
        'academic_term.created',
        'academic_term.updated',
        'academic_term.deleted',
      ].sort(),
    );
    const find = (action: string) => events.find((e) => e.action === action)!;
    expect(find('grade_offering.updated').changes).toEqual(
      expect.arrayContaining([
        { field: 'displayName', from: 'Grade 8', to: 'Class VIII' },
        { field: 'capacity', from: null, to: 90 },
      ]),
    );
    expect(find('academic_term.updated').changes).toEqual([{ field: 'endDate', from: '2026-09-30', to: '2026-09-15' }]);
    expect(find('subject_offering.updated').changes).toEqual([{ field: 'offeringType', from: 'MANDATORY', to: 'ELECTIVE' }]);
    expect(find('academic_session.updated').changes).toEqual([{ field: 'name', from: 'Academic Year 2026-27', to: 'AY 26-27' }]);
    expect(find('academic_session.created')).toMatchObject({ entityType: 'academic_session', actor: { role: 'SCHOOL_ADMIN', name: 'Ada Admin' } });
    expect(find('grade_offering.deleted').metadata).toMatchObject({ removed: { sections: 0, subjectOfferings: 0 } });

    // Subject master events are per subject.
    await t.agent.patch(`${API}/subjects/${t.subjects.MATH}`).send({ name: 'Maths' }).expect(200);
    await t.agent.put(`${API}/subjects/${t.subjects.MATH}/board-codes`).send({ boardRuleVersionId: t.ref.ruleVersionId('CBSE'), boardSubjectCode: '041' }).expect(200);
    const subjectEvents = (await t.agent.get(`${API}/audit`).query({ entityType: 'subject', entityId: t.subjects.MATH }).expect(200)).body.data.items;
    expect(subjectEvents.map((e: { action: string }) => e.action).sort()).toEqual(['subject.board_code_set', 'subject.created', 'subject.updated']);
    expect(subjectEvents.find((e: { action: string }) => e.action === 'subject.board_code_set').changes).toEqual([
      { field: 'boardSubjectCode', from: null, to: '041' },
    ]);
  });

  it('a failed change leaves no audit row behind', async () => {
    const t = await draftSession();
    const before = (await auditForSession(t.agent, t.id)).length;
    await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'Bad', code: 'B', startDate: '2025-01-01', endDate: '2025-02-01' }).expect(400);
    await t.agent.post(`${t.sessionUrl}/grade-offerings`).send({ locationId: t.pkl.locationId, gradeIds: [t.ref.gradeId.G01!] }).expect(409);
    expect((await auditForSession(t.agent, t.id)).length).toBe(before);
  });
});

describe('limited and denied roles', () => {
  it('Faculty and Staff read PUBLISHED / ACTIVE / CLOSED structure only, never drafts or configuration; Parents get nothing', async () => {
    const t = await draftSession();
    const [g] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G06!]);
    await t.agent.post(`${API}/grade-offerings/${g!.gradeOfferingId}/subjects`).send({ subjectIds: [t.subjects.MATH], offeringType: 'MANDATORY' }).expect(201);

    for (const role of ['FACULTY', 'STAFF'] as const) {
      const user = await createUserAndLogin(t.tenantId, role);
      // Draft: invisible everywhere.
      expect((await user.agent.get(`${API}/academic-sessions`).expect(200)).body.data).toEqual([]);
      expectError(await user.agent.get(t.sessionUrl), 404, 'NOT_FOUND');
      expectError(await user.agent.get(`${t.sessionUrl}/grade-offerings`), 404, 'NOT_FOUND');
      expectError(await user.agent.get(`${t.sessionUrl}/terms`), 404, 'NOT_FOUND');
      expectError(await user.agent.get(`${API}/grade-offerings/${g!.gradeOfferingId}`), 404, 'NOT_FOUND');
      expectError(await user.agent.get(`${API}/grade-offerings/${g!.gradeOfferingId}/subjects`), 404, 'NOT_FOUND');
      expect((await user.agent.get(`${API}/subjects`).query({ gradeId: t.ref.gradeId.G06! }).expect(200)).body.data.items).toEqual([]); // no leak via the grade filter

      for (const status of ['PUBLISHED', 'ACTIVE', 'CLOSED'] as const) {
        await forceStatus(t.tenantId, t.id, status);
        const list = (await user.agent.get(`${API}/academic-sessions`).expect(200)).body.data as AcademicSessionDTO[];
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ status, warnings: [] });
        expect(list[0]).not.toHaveProperty('lastValidation');
        expect((await user.agent.get(`${t.sessionUrl}/grade-offerings`).expect(200)).body.data).toHaveLength(1);
        expect((await user.agent.get(`${API}/grade-offerings/${g!.gradeOfferingId}/subjects`).expect(200)).body.data).toHaveLength(1);
        expect((await user.agent.get(`${API}/subjects`).query({ gradeId: t.ref.gradeId.G06! }).expect(200)).body.data.items).toHaveLength(1);
      }
      // …but never archived ones, and never write.
      await forceStatus(t.tenantId, t.id, 'ARCHIVED');
      expectError(await user.agent.get(t.sessionUrl), 404, 'NOT_FOUND');
      await forceStatus(t.tenantId, t.id, 'CLOSED');
      expectError(await user.agent.post(`${API}/subjects`).send({ subjectCode: 'NEW', name: 'New', category: 'OTHER' }), 403, 'FORBIDDEN');
      expectError(await user.agent.get(`${API}/audit`), 403, 'FORBIDDEN');
      await forceStatus(t.tenantId, t.id, 'DRAFT');
    }

    const parent = await createUserAndLogin(t.tenantId, 'PARENT');
    for (const url of [`${API}/boards`, `${API}/grades`, `${API}/subjects`, `${API}/academic-sessions`, t.sessionUrl]) {
      expectError(await parent.agent.get(url), 403, 'FORBIDDEN');
    }
  });
});
