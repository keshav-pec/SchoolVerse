import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AcademicSessionDTO, AcademicTermDTO, BoardDTO, BoardRuleVersionDTO, ClassMasterDTO, SubjectDTO,
  SubjectOfferingDTO, ChoiceGroupDTO, ConstraintDTO, ProgrammeDTO, ValidationIssueDTO,
  ValidationResultDTO, AcademicContextDTO, AcademicContextClassesDTO, AcademicOverviewDTO,
} from '@shared';
import { registerAcademicDependency, unregisterAcademicDependency } from '../src/modules/academic/dependencies';
import { ClassOffering, SectionOffering, SubjectOffering } from '../src/modules/academic/offering.model';
import { AcademicTerm, AcademicSession } from '../src/modules/academic/session.model';
import {
  academicSchool, addClasses, API, auditForSession, createSession, createStarterSubjects,
  createUserAndLogin, draftSession, expectError, forceStatus, loadReference, setupSchool,
  useTestDatabase, createMoreSubjects, offer, type DraftSession, app, get, makePublishable,
  serviceContextFor,
} from './helpers';
import { validateAcademicSession, type ValidationInput } from '../src/modules/academic/validation';
import { SubjectChoiceConstraint, SubjectChoiceGroup, AcademicProgramme } from '../src/modules/academic/rules.model';
import request from 'supertest';
import { academicService } from '../src/modules/academic/academic.service';
import { seedDemo } from '../src/scripts/seed';

useTestDatabase();
beforeEach(async () => {
  await loadReference();
});

describe('reference data (AS-01, AS-03)', () => {
  it('seeded classes and boards are visible to every tenant and read-only', async () => {
    const a = await academicSchool('School A');
    const b = await setupSchool({ workspace: 'School B' });

    for (const agent of [a.agent, b.agent]) {
      const classes = (await agent.get(`${API}/classes`).expect(200)).body.data as ClassMasterDTO[];
      expect(classes).toHaveLength(17);
      expect(classes.map((g) => g.canonicalCode)).toEqual(['PRE_NURSERY', 'NURSERY', 'KG', 'LKG', 'UKG', ...Array.from({ length: 12 }, (_, i) => `G${String(i + 1).padStart(2, '0')}`)]);
      const stage = (code: string) => classes.find((g) => g.canonicalCode === code)!.educationStage;
      expect([stage('KG'), stage('G02'), stage('G03'), stage('G05'), stage('G06'), stage('G08'), stage('G09'), stage('G12')]).toEqual([
        'FOUNDATIONAL', 'FOUNDATIONAL', 'PREPARATORY', 'PREPARATORY', 'MIDDLE', 'MIDDLE', 'SECONDARY', 'SECONDARY',
      ]);
      expect(classes.filter((g) => g.isBoardClass).map((g) => g.canonicalCode)).toEqual(['G10', 'G12']);
      expect(classes.filter((g) => g.isPrePrimary).map((g) => g.canonicalCode)).toEqual(['PRE_NURSERY', 'NURSERY', 'KG', 'LKG', 'UKG']);

      const boards = (await agent.get(`${API}/boards`).expect(200)).body.data as BoardDTO[];
      expect(boards.map((x) => x.boardCode).sort()).toEqual(['CBSE', 'CISCE', 'CUSTOM', 'PSEB', 'STATE_TEST']);
      expect(boards.every((x) => x.isSystem)).toBe(true);
      for (const board of boards) {
        const versions = (await agent.get(`${API}/boards/${board.boardId}/rule-versions`).expect(200)).body.data as BoardRuleVersionDTO[];
        expect(versions).toMatchObject([{ name: '2026-27', status: 'PUBLISHED', isSystem: true }]);
      }
    }

    // Read-only: no write routes exist for classes, and built-in boards refuse rule versions.
    expectError(await a.agent.post(`${API}/classes`).send({ canonicalCode: 'X' }), 404, 'ROUTE_NOT_FOUND');
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

  it('filters by name or code, category, language, status, board code and class', async () => {
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
    const [g6] = await addClasses(agent, session.academicSessionId, moh.locationId, [ref.classId.G06!]);
    await agent.post(`${API}/class-offerings/${g6!.classOfferingId}/subjects`).send({ subjectIds: [ids.ENG, ids.MATH], offeringType: 'MANDATORY' }).expect(201);
    expect(await list({ classId: ref.classId.G06! })).toEqual(['ENG', 'MATH']);
    expect(await list({ classId: ref.classId.G07! })).toEqual([]);

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

  it('a location cannot be removed once classes or terms exist for it, nor change rule version under linked board codes', async () => {
    const t = await draftSession();
    const [g] = await addClasses(t.agent, t.id, t.chd.locationId, [t.ref.classId.G08!]);
    const keepMoh = [t.ref.pin(t.moh.locationId, 'CBSE')];

    const blocked = expectError(await t.agent.patch(t.sessionUrl).send({ locations: keepMoh }), 409, 'ACADEMIC_HAS_DEPENDENCIES');
    expect(blocked.details.dependencies).toMatchObject([{ key: 'academic.class_offerings', count: 1 }]);
    await t.agent.delete(`${API}/class-offerings/${g!.classOfferingId}`).expect(204);

    await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'CHD term', code: 'C1', locationId: t.chd.locationId, startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201);
    expect(expectError(await t.agent.patch(t.sessionUrl).send({ locations: keepMoh }), 409, 'ACADEMIC_HAS_DEPENDENCIES').details.dependencies).toMatchObject([{ key: 'academic.terms' }]);
    const term = (await t.agent.get(`${t.sessionUrl}/terms`).expect(200)).body.data[0] as AcademicTermDTO;
    await t.agent.delete(`${API}/terms/${term.termId}`).expect(204);
    expect(((await t.agent.patch(t.sessionUrl).send({ locations: keepMoh }).expect(200)).body.data as AcademicSessionDTO).locations).toHaveLength(1);

    // Linked board codes pin the rule version.
    await t.agent.put(`${API}/subjects/${t.subjects.MATH}/board-codes`).send({ boardRuleVersionId: t.ref.ruleVersionId('CBSE'), boardSubjectCode: '041' }).expect(200);
    const [g6] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G06!]);
    await t.agent.post(`${API}/class-offerings/${g6!.classOfferingId}/subjects`).send({ subjectIds: [t.subjects.MATH], offeringType: 'MANDATORY' }).expect(201);
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
    const [g] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G06!]);
    await t.agent.post(`${API}/class-offerings/${g!.classOfferingId}/sections`).send({ codes: ['A'] }).expect(201);
    await t.agent.post(`${API}/class-offerings/${g!.classOfferingId}/subjects`).send({ subjectIds: [t.subjects.ENG], offeringType: 'MANDATORY' }).expect(201);
    await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'Term 1', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201);

    for (const status of ['PUBLISHED', 'ACTIVE', 'CLOSED', 'ARCHIVED'] as const) {
      await forceStatus(t.tenantId, t.id, status);
      expectError(await t.agent.delete(t.sessionUrl), 409, 'SESSION_NOT_DRAFT');
    }
    await forceStatus(t.tenantId, t.id, 'DRAFT');
    await t.agent.delete(t.sessionUrl).expect(204);
    expectError(await t.agent.get(t.sessionUrl), 404, 'NOT_FOUND');
    const left = await Promise.all([ClassOffering, SectionOffering, SubjectOffering, AcademicTerm].map((m) => (m as typeof ClassOffering).countDocuments({ tenantId: t.tenantId })));
    expect(left).toEqual([0, 0, 0, 0]);
    // The code is free again.
    await createSession(t.agent, []);
  });
});

describe('class offerings and sections (AS-03, AS-04)', () => {
  it('QA 5c: sets up the same sections for every class in one go, skipping what a class already has, then classes are adjusted one by one', async () => {
    const t = await draftSession();
    const classes = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.NURSERY!, t.ref.classId.G02!, t.ref.classId.G03!]);
    const [nursery, g2, g3] = classes.map((g) => g.classOfferingId) as [string, string, string];
    // Class 2 already has B, entered by hand.
    await t.agent.post(`${API}/class-offerings/${g2}/sections`).send({ codes: ['B'] }).expect(201);

    const url = `${t.sessionUrl}/class-offerings/sections`;
    const result = (await t.agent.post(url).send({ locationId: t.moh.locationId, codes: ['a', 'B', 'C'] }).expect(201)).body.data;
    expect(result).toEqual({ classes: 3, classesChanged: 3, sectionsAdded: 8, sectionsSkipped: 1 });

    const codes = async (id: string) => ((await t.agent.get(`${API}/class-offerings/${id}/sections`).expect(200)).body.data as { sectionCode: string }[]).map((s) => s.sectionCode);
    expect(await codes(nursery)).toEqual(['A', 'B', 'C']);
    expect(await codes(g2)).toEqual(['B', 'A', 'C']); // the existing B keeps its place; new ones follow
    expect(await codes(g3)).toEqual(['A', 'B', 'C']);

    // Pressing it again changes nothing.
    expect((await t.agent.post(url).send({ locationId: t.moh.locationId, codes: ['A', 'B', 'C'] }).expect(201)).body.data).toMatchObject({ classesChanged: 0, sectionsAdded: 0, sectionsSkipped: 9 });

    // One-by-one changes still work: add D to one class only.
    await t.agent.post(`${API}/class-offerings/${g3}/sections`).send({ codes: ['D'] }).expect(201);
    expect(await codes(g3)).toEqual(['A', 'B', 'C', 'D']);
    expect(await codes(nursery)).toEqual(['A', 'B', 'C']);

    // Repeated codes in the request, and a location with no classes, are refused.
    expectError(await t.agent.post(url).send({ locationId: t.moh.locationId, codes: ['A', 'a'] }), 409, 'SECTION_CODE_TAKEN');
    expectError(await t.agent.post(url).send({ locationId: t.chd.locationId, codes: ['A'] }), 400, 'VALIDATION_FAILED');
  });

  it('QA 5b: a school can give a class its own name and code when adding it', async () => {
    const t = await draftSession();
    const { classId } = t.ref;
    const created = (
      await t.agent
        .post(`${t.sessionUrl}/class-offerings`)
        .send({ locationId: t.moh.locationId, classIds: [classId.NURSERY, classId.G02], labels: { [classId.NURSERY!]: { displayName: 'Playgroup', displayCode: 'PG' } } })
        .expect(201)
    ).body.data;
    expect(created).toMatchObject([
      { displayName: 'Playgroup', displayCode: 'PG', canonicalCode: 'NURSERY' }, // renamed, same master class underneath
      { displayName: 'Class 2', displayCode: '2' }, // not renamed, standard name
    ]);
    // Blank names are refused.
    expectError(
      await t.agent.post(`${t.sessionUrl}/class-offerings`).send({ locationId: t.moh.locationId, classIds: [classId.G03], labels: { [classId.G03!]: { displayName: ' ', displayCode: '3' } } }),
      400,
      'VALIDATION_FAILED',
    );
  });

  it('QA 5: adds classes in bulk with default labels, then sections in bulk', async () => {
    const t = await draftSession();
    const classes = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G03!, t.ref.classId.NURSERY!, t.ref.classId.G02!]);
    expect(classes.map((g) => g.displayName)).toEqual(['Nursery', 'Class 2', 'Class 3']); // master order, default labels

    const list = (await t.agent.get(`${t.sessionUrl}/class-offerings`).query({ locationId: t.moh.locationId }).expect(200)).body.data;
    expect(list).toMatchObject([
      { displayName: 'Nursery', displayCode: 'N', canonicalCode: 'NURSERY', status: 'ACTIVE', sectionCount: 0 },
      { displayName: 'Class 2', displayCode: '2' },
      { displayName: 'Class 3', displayCode: '3' },
    ]);

    const g3 = classes[2]!.classOfferingId;
    const renamed = (await t.agent.patch(`${API}/class-offerings/${g3}`).send({ displayName: 'Class III', displayCode: 'III', medium: 'English', capacity: 120 }).expect(200)).body.data;
    expect(renamed).toMatchObject({ displayName: 'Class III', displayCode: 'III', medium: 'English', capacity: 120 });
    expect(renamed.canonicalCode).toBe('G03'); // the master identity is untouched

    const sections = (await t.agent.post(`${API}/class-offerings/${g3}/sections`).send({ codes: ['A', 'B', 'C'], capacity: 40 }).expect(201)).body.data;
    expect(sections.map((s: { sectionCode: string; sequenceOrder: number }) => [s.sectionCode, s.sequenceOrder])).toEqual([['A', 1], ['B', 2], ['C', 3]]);
    const more = (await t.agent.post(`${API}/class-offerings/${g3}/sections`).send({ codes: ['d'] }).expect(201)).body.data;
    expect(more[0]).toMatchObject({ sectionCode: 'D', sequenceOrder: 4 });

    const read = (await t.agent.get(`${API}/class-offerings/${g3}/sections`).expect(200)).body.data;
    expect(read.map((s: { sectionCode: string }) => s.sectionCode)).toEqual(['A', 'B', 'C', 'D']);
    expect((await t.agent.get(`${API}/class-offerings/${g3}`).expect(200)).body.data.sectionCount).toBe(4);

    const section = read[0];
    const patched = (await t.agent.patch(`${API}/sections/${section.sectionOfferingId}`).send({ displayName: 'Rose', capacity: 35 }).expect(200)).body.data;
    expect(patched).toMatchObject({ displayName: 'Rose', capacity: 35, sectionCode: 'A' });
  });

  it('QA 4: the same class can be set up differently at two locations', async () => {
    const t = await draftSession();
    const [moh] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G08!], { medium: 'English' });
    const [chd] = await addClasses(t.agent, t.id, t.chd.locationId, [t.ref.classId.G08!], { medium: 'Punjabi' });
    expect(moh!.classOfferingId).not.toBe(chd!.classOfferingId);
    await t.agent.patch(`${API}/class-offerings/${chd!.classOfferingId}`).send({ displayName: 'Standard 8', capacity: 30 }).expect(200);

    const all = (await t.agent.get(`${t.sessionUrl}/class-offerings`).expect(200)).body.data as { locationId: string; displayName: string; medium: string; capacity: number | null }[];
    expect(all.find((g) => g.locationId === t.moh.locationId)).toMatchObject({ displayName: 'Class 8', medium: 'English', capacity: null });
    expect(all.find((g) => g.locationId === t.chd.locationId)).toMatchObject({ displayName: 'Standard 8', medium: 'Punjabi', capacity: 30 });

    // …but the same class cannot be added twice at one location, and the location must be in the session.
    const dup = expectError(
      await t.agent.post(`${t.sessionUrl}/class-offerings`).send({ locationId: t.moh.locationId, classIds: [t.ref.classId.G07!, t.ref.classId.G08!] }),
      409,
      'CLASS_OFFERING_EXISTS',
    );
    expect(dup.details.classIds).toEqual([t.ref.classId.G08]);
    expect(await ClassOffering.countDocuments({ tenantId: t.tenantId, locationId: t.moh.locationId })).toBe(1); // G07 not added either
    expectError(await t.agent.post(`${t.sessionUrl}/class-offerings`).send({ locationId: t.pkl.locationId, classIds: [t.ref.classId.G08!] }), 409, 'LOCATION_NOT_IN_SESSION');
    expectError(await t.agent.post(`${t.sessionUrl}/class-offerings`).send({ locationId: t.moh.locationId, classIds: [] }), 400, 'VALIDATION_FAILED');
  });

  it('QA 6: a duplicate section is blocked, in any letter case, but other classes may reuse the code', async () => {
    const t = await draftSession();
    const [moh] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G08!]);
    const [chd] = await addClasses(t.agent, t.id, t.chd.locationId, [t.ref.classId.G08!]);
    const url = (id: string) => `${API}/class-offerings/${id}/sections`;

    await t.agent.post(url(moh!.classOfferingId)).send({ codes: ['A', 'B'] }).expect(201);
    expectError(await t.agent.post(url(moh!.classOfferingId)).send({ codes: ['a'] }), 409, 'SECTION_CODE_TAKEN');
    const clash = expectError(await t.agent.post(url(moh!.classOfferingId)).send({ codes: ['C', 'b'] }), 409, 'SECTION_CODE_TAKEN');
    expect(clash.details.codes).toEqual(['B']);
    expectError(await t.agent.post(url(moh!.classOfferingId)).send({ codes: ['X', 'x'] }), 409, 'SECTION_CODE_TAKEN'); // repeated in the request
    expect((await t.agent.get(url(moh!.classOfferingId)).expect(200)).body.data).toHaveLength(2); // the failed requests added nothing

    // Mohali VIII-A and Chandigarh VIII-A never collide.
    await t.agent.post(url(chd!.classOfferingId)).send({ codes: ['A'] }).expect(201);
    expect(expectError(await t.agent.post(url(moh!.classOfferingId)).send({ codes: ['??'] }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('codes.0');
  });
});

describe('subject offerings (AS-07)', () => {
  it('QA 8: offers mandatory and elective subjects, once each, and only active subjects', async () => {
    const t = await draftSession();
    const [g] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G06!]);
    const url = `${API}/class-offerings/${g!.classOfferingId}/subjects`;

    const core = (await t.agent.post(url).send({ subjectIds: [t.subjects.MATH, t.subjects.SCI], offeringType: 'MANDATORY' }).expect(201)).body.data as SubjectOfferingDTO[];
    expect(core.map((o) => o.subjectCode).sort()).toEqual(['MATH', 'SCI']);
    const elective = (await t.agent.post(url).send({ subjectIds: [t.subjects.HIN], offeringType: 'ELECTIVE' }).expect(201)).body.data as SubjectOfferingDTO[];
    expect(elective[0]).toMatchObject({ subjectCode: 'HIN', offeringType: 'ELECTIVE', status: 'ACTIVE', boardSubjectCode: null });

    const listed = (await t.agent.get(url).expect(200)).body.data as SubjectOfferingDTO[];
    expect(listed.map((o) => `${o.subjectCode}:${o.offeringType}`)).toEqual(['HIN:ELECTIVE', 'MATH:MANDATORY', 'SCI:MANDATORY']);
    expect((await t.agent.get(`${API}/class-offerings/${g!.classOfferingId}`).expect(200)).body.data.subjectCount).toBe(3);

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

    const [g] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G06!]); // MOH follows CBSE
    const url = `${API}/class-offerings/${g!.classOfferingId}/subjects`;
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
    const [g6, g7] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G06!, t.ref.classId.G07!]);
    const [chd8] = await addClasses(t.agent, t.id, t.chd.locationId, [t.ref.classId.G08!]);
    await t.agent.post(`${API}/class-offerings/${g6!.classOfferingId}/subjects`).send({ subjectIds: [t.subjects.MATH, t.subjects.SCI], offeringType: 'MANDATORY' }).expect(201);
    await t.agent.post(`${API}/class-offerings/${g6!.classOfferingId}/subjects`).send({ subjectIds: [t.subjects.HIN], offeringType: 'ELECTIVE' }).expect(201);
    expect((await t.agent.get(`${API}/class-offerings/${g7!.classOfferingId}/subjects`).expect(200)).body.data).toEqual([]); // nothing is copied automatically

    const copyUrl = (to: string, from: string) => `${API}/class-offerings/${to}/subjects/copy-from/${from}`;
    await t.agent.post(`${API}/class-offerings/${g7!.classOfferingId}/subjects`).send({ subjectIds: [t.subjects.SCI], offeringType: 'MANDATORY' }).expect(201);
    const first = (await t.agent.post(copyUrl(g7!.classOfferingId, g6!.classOfferingId)).expect(201)).body.data;
    expect(first.created.map((o: SubjectOfferingDTO) => `${o.subjectCode}:${o.offeringType}`).sort()).toEqual(['HIN:ELECTIVE', 'MATH:MANDATORY']);
    expect(first.skipped).toBe(1);
    expect((await t.agent.post(copyUrl(g7!.classOfferingId, g6!.classOfferingId)).expect(201)).body.data).toMatchObject({ created: [], skipped: 3 });

    expect(expectError(await t.agent.post(copyUrl(g7!.classOfferingId, g7!.classOfferingId)), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('sourceClassOfferingId');
    // Another session's class is out of reach.
    const other = await createSession(t.agent, [t.ref.pin(t.moh.locationId)], { code: 'NEXT', startDate: '2027-04-01', endDate: '2028-03-31' });
    const [otherG] = await addClasses(t.agent, other.academicSessionId, t.moh.locationId, [t.ref.classId.G06!]);
    expect(expectError(await t.agent.post(copyUrl(g7!.classOfferingId, otherG!.classOfferingId)), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('sourceClassOfferingId');
    expect((await t.agent.post(copyUrl(chd8!.classOfferingId, g6!.classOfferingId)).expect(201)).body.data.created).toHaveLength(3); // other location, same session: fine
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
    const [g6] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G06!]);
    const [section] = (await t.agent.post(`${API}/class-offerings/${g6!.classOfferingId}/sections`).send({ codes: ['A'] }).expect(201)).body.data;
    await forceStatus(t.tenantId, t.id, 'ACTIVE');

    // Additive and display edits are fine.
    await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G07!]);
    await t.agent.post(`${API}/class-offerings/${g6!.classOfferingId}/sections`).send({ codes: ['B'] }).expect(201);
    await t.agent.patch(`${API}/class-offerings/${g6!.classOfferingId}`).send({ displayName: 'Class VI' }).expect(200);
    await t.agent.patch(t.sessionUrl).send({ name: 'Renamed while active' }).expect(200);

    // Hard delete is never offered once the session is past DRAFT.
    expectError(await t.agent.delete(`${API}/sections/${section.sectionOfferingId}`), 409, 'USE_DEACTIVATE_INSTEAD');
    expectError(await t.agent.delete(`${API}/class-offerings/${g6!.classOfferingId}`), 409, 'USE_DEACTIVATE_INSTEAD');

    // A downstream module (here a stub) says the section is in use → deactivating it is refused.
    registerAcademicDependency({
      key: 'test.faculty-assignments',
      label: 'Faculty assignments',
      entityTypes: ['section_offering', 'class_offering'],
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
    expect((await t.agent.patch(`${API}/class-offerings/${g6!.classOfferingId}`).send({ status: 'INACTIVE' }).expect(200)).body.data.status).toBe('INACTIVE');
  });

  it('PUBLISHED can still be reshaped, including deletes of offerings, since nobody has used it', async () => {
    const t = await draftSession();
    await forceStatus(t.tenantId, t.id, 'PUBLISHED');
    const [g] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G06!]);
    // Delete policy: hard delete only while DRAFT; a published session deactivates instead.
    expectError(await t.agent.delete(`${API}/class-offerings/${g!.classOfferingId}`), 409, 'USE_DEACTIVATE_INSTEAD');
    await t.agent.patch(`${API}/class-offerings/${g!.classOfferingId}`).send({ status: 'INACTIVE' }).expect(200);
    const term = (await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'T', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201)).body.data;
    await t.agent.delete(`${API}/terms/${term.termId}`).expect(204);
  });

  it('QA 18 (part): CLOSED and ARCHIVED sessions stay readable but every change is refused', async () => {
    const t = await draftSession();
    const [g] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G06!]);
    const [section] = (await t.agent.post(`${API}/class-offerings/${g!.classOfferingId}/sections`).send({ codes: ['A'] }).expect(201)).body.data;
    const [offering] = (await t.agent.post(`${API}/class-offerings/${g!.classOfferingId}/subjects`).send({ subjectIds: [t.subjects.ENG], offeringType: 'MANDATORY' }).expect(201)).body.data;
    const term = (await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'T', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201)).body.data;

    for (const status of ['CLOSED', 'ARCHIVED'] as const) {
      await forceStatus(t.tenantId, t.id, status);
      const refused = [
        t.agent.patch(t.sessionUrl).send({ name: 'x' }),
        t.agent.post(`${t.sessionUrl}/class-offerings`).send({ locationId: t.moh.locationId, classIds: [t.ref.classId.G07!] }),
        t.agent.patch(`${API}/class-offerings/${g!.classOfferingId}`).send({ displayName: 'x' }),
        t.agent.delete(`${API}/class-offerings/${g!.classOfferingId}`),
        t.agent.post(`${API}/class-offerings/${g!.classOfferingId}/sections`).send({ codes: ['Z'] }),
        t.agent.patch(`${API}/sections/${section.sectionOfferingId}`).send({ displayName: 'x' }),
        t.agent.delete(`${API}/sections/${section.sectionOfferingId}`),
        t.agent.post(`${API}/class-offerings/${g!.classOfferingId}/subjects`).send({ subjectIds: [t.subjects.HIN], offeringType: 'MANDATORY' }),
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
      expect((await t.agent.get(`${t.sessionUrl}/class-offerings`).expect(200)).body.data).toHaveLength(1);
      expect((await t.agent.get(`${API}/class-offerings/${g!.classOfferingId}/subjects`).expect(200)).body.data).toHaveLength(1);
      expect((await t.agent.get(`${t.sessionUrl}/terms`).expect(200)).body.data).toHaveLength(1);
    }
  });
});

describe('location dependency (Module 1 registry)', () => {
  it('a location with class offerings in a non-closed session cannot be archived', async () => {
    const t = await draftSession();
    await addClasses(t.agent, t.id, t.chd.locationId, [t.ref.classId.G06!]);
    await t.agent.post(`${API}/locations/${t.chd.locationId}/deactivate`).expect(200);

    const blocked = expectError(await t.agent.post(`${API}/locations/${t.chd.locationId}/archive`), 409, 'LOCATION_HAS_DEPENDENCIES');
    expect(blocked.details.dependencies).toMatchObject([{ key: 'academic.structure', label: 'Academic structure', count: 1 }]);
    // The code is locked and the location cannot be deleted once a session has used it.
    expectError(await t.agent.patch(`${API}/locations/${t.chd.locationId}`).send({ locationCode: 'CHD2' }), 409, 'LOCATION_CODE_LOCKED');

    await forceStatus(t.tenantId, t.id, 'CLOSED');
    await t.agent.post(`${API}/locations/${t.chd.locationId}/archive`).expect(200);
  });

  it('a location used by a session without classes is not blocked from archiving, but the session keeps its code locked', async () => {
    const t = await draftSession();
    await t.agent.post(`${API}/locations/${t.chd.locationId}/deactivate`).expect(200);
    expectError(await t.agent.patch(`${API}/locations/${t.chd.locationId}`).send({ locationCode: 'CHD2' }), 409, 'LOCATION_CODE_LOCKED');
    await t.agent.post(`${API}/locations/${t.chd.locationId}/archive`).expect(200);
  });
});

describe('audit trail (AS-17)', () => {
  it('every mutation writes an audit row with field-level changes, grouped by session', async () => {
    const t = await draftSession();
    const [g] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G08!]);
    await t.agent.patch(`${API}/class-offerings/${g!.classOfferingId}`).send({ displayName: 'Class VIII', capacity: 90 }).expect(200);
    const [section] = (await t.agent.post(`${API}/class-offerings/${g!.classOfferingId}/sections`).send({ codes: ['A'] }).expect(201)).body.data;
    await t.agent.patch(`${API}/sections/${section.sectionOfferingId}`).send({ capacity: 40 }).expect(200);
    const [offering] = (await t.agent.post(`${API}/class-offerings/${g!.classOfferingId}/subjects`).send({ subjectIds: [t.subjects.MATH], offeringType: 'MANDATORY' }).expect(201)).body.data;
    await t.agent.patch(`${API}/subject-offerings/${offering.subjectOfferingId}`).send({ offeringType: 'ELECTIVE' }).expect(200);
    const term = (await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'Term 1', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201)).body.data;
    await t.agent.patch(`${API}/terms/${term.termId}`).send({ endDate: '2026-09-15' }).expect(200);
    await t.agent.patch(t.sessionUrl).send({ name: 'AY 26-27' }).expect(200);
    await t.agent.delete(`${API}/terms/${term.termId}`).expect(204);
    await t.agent.delete(`${API}/subject-offerings/${offering.subjectOfferingId}`).expect(204);
    await t.agent.delete(`${API}/sections/${section.sectionOfferingId}`).expect(204);
    await t.agent.delete(`${API}/class-offerings/${g!.classOfferingId}`).expect(204);

    const events = await auditForSession(t.agent, t.id);
    const actions = events.map((e) => e.action);
    expect(actions.sort()).toEqual(
      [
        'academic_session.created',
        'academic_session.updated',
        'class_offering.created',
        'class_offering.updated',
        'class_offering.deleted',
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
    expect(find('class_offering.updated').changes).toEqual(
      expect.arrayContaining([
        { field: 'displayName', from: 'Class 8', to: 'Class VIII' },
        { field: 'capacity', from: null, to: 90 },
      ]),
    );
    expect(find('academic_term.updated').changes).toEqual([{ field: 'endDate', from: '2026-09-30', to: '2026-09-15' }]);
    expect(find('subject_offering.updated').changes).toEqual([{ field: 'offeringType', from: 'MANDATORY', to: 'ELECTIVE' }]);
    expect(find('academic_session.updated').changes).toEqual([{ field: 'name', from: 'Academic Year 2026-27', to: 'AY 26-27' }]);
    expect(find('academic_session.created')).toMatchObject({ entityType: 'academic_session', actor: { role: 'SCHOOL_ADMIN', name: 'Ada Admin' } });
    expect(find('class_offering.deleted').metadata).toMatchObject({ removed: { sections: 0, subjectOfferings: 0 } });

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
    await t.agent.post(`${t.sessionUrl}/class-offerings`).send({ locationId: t.pkl.locationId, classIds: [t.ref.classId.G01!] }).expect(409);
    expect((await auditForSession(t.agent, t.id)).length).toBe(before);
  });
});

describe('limited and denied roles', () => {
  it('Faculty and Staff read PUBLISHED / ACTIVE / CLOSED structure only, never drafts or configuration; Parents get nothing', async () => {
    const t = await draftSession();
    const [g] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G06!]);
    await t.agent.post(`${API}/class-offerings/${g!.classOfferingId}/subjects`).send({ subjectIds: [t.subjects.MATH], offeringType: 'MANDATORY' }).expect(201);

    for (const role of ['FACULTY', 'STAFF'] as const) {
      const user = await createUserAndLogin(t.tenantId, role);
      // Draft: invisible everywhere.
      expect((await user.agent.get(`${API}/academic-sessions`).expect(200)).body.data).toEqual([]);
      expectError(await user.agent.get(t.sessionUrl), 404, 'NOT_FOUND');
      expectError(await user.agent.get(`${t.sessionUrl}/class-offerings`), 404, 'NOT_FOUND');
      expectError(await user.agent.get(`${t.sessionUrl}/terms`), 404, 'NOT_FOUND');
      expectError(await user.agent.get(`${API}/class-offerings/${g!.classOfferingId}`), 404, 'NOT_FOUND');
      expectError(await user.agent.get(`${API}/class-offerings/${g!.classOfferingId}/subjects`), 404, 'NOT_FOUND');
      expect((await user.agent.get(`${API}/subjects`).query({ classId: t.ref.classId.G06! }).expect(200)).body.data.items).toEqual([]); // no leak via the class filter

      for (const status of ['PUBLISHED', 'ACTIVE', 'CLOSED'] as const) {
        await forceStatus(t.tenantId, t.id, status);
        const list = (await user.agent.get(`${API}/academic-sessions`).expect(200)).body.data as AcademicSessionDTO[];
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ status, warnings: [] });
        expect(list[0]).not.toHaveProperty('lastValidation');
        expect((await user.agent.get(`${t.sessionUrl}/class-offerings`).expect(200)).body.data).toHaveLength(1);
        expect((await user.agent.get(`${API}/class-offerings/${g!.classOfferingId}/subjects`).expect(200)).body.data).toHaveLength(1);
        expect((await user.agent.get(`${API}/subjects`).query({ classId: t.ref.classId.G06! }).expect(200)).body.data.items).toHaveLength(1);
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
    for (const url of [`${API}/boards`, `${API}/classes`, `${API}/subjects`, `${API}/academic-sessions`, t.sessionUrl]) {
      expectError(await parent.agent.get(url), 403, 'FORBIDDEN');
    }
  });
});

/** Class 6 at Mohali offering English, Hindi, Punjabi, Urdu, Mathematics and Science. */
async function class6() {
  const t = await draftSession();
  const more = await createMoreSubjects(t.agent);
  const [g] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G06!]);
  const url = `${API}/class-offerings/${g!.classOfferingId}`;
  const core = await offer(t.agent, g!.classOfferingId, [t.subjects.MATH!, t.subjects.SCI!, t.subjects.ENG!]);
  const languages = await offer(t.agent, g!.classOfferingId, [more.PUN!, t.subjects.HIN!, more.URD!], 'LANGUAGE');
  const o = { ...core, ...languages } as Record<string, string>;
  const group = async (body: Record<string, unknown>) => (await t.agent.post(`${url}/choice-groups`).send(body).expect(201)).body.data as ChoiceGroupDTO;
  const post = (path: string, body: Record<string, unknown>) => t.agent.post(`${url}/${path}`).send(body);
  return { ...t, more, url, classOfferingId: g!.classOfferingId, o, group, post };
}

const validate = async (t: DraftSession) => (await t.agent.post(`${t.sessionUrl}/validate`).expect(200)).body.data as ValidationResultDTO;
const find = (r: ValidationResultDTO, code: string) => r.issues.filter((i) => i.code === code);

describe('subject choice groups (AS-08)', () => {
  it('QA 9: a language group is just data — Core, Language 1 (choose one of Punjabi / Hindi / Urdu), Language 2', async () => {
    const t = await class6();
    const core = await t.group({ name: 'Core', ruleType: 'REQUIRED_ALL', subjectOfferingIds: [t.o.MATH!, t.o.SCI!] });
    const lang1 = await t.group({ name: 'Language 1', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.PUN!, t.o.HIN!, t.o.URD!] });
    const lang2 = await t.group({ name: 'Language 2', ruleType: 'REQUIRED_ALL', subjectOfferingIds: [t.o.ENG!] });

    expect(core).toMatchObject({ ruleType: 'REQUIRED_ALL', min: 2, max: 2, sequence: 1, status: 'ACTIVE', summary: 'Take all of Mathematics, Science' });
    expect(lang1).toMatchObject({ ruleType: 'CHOOSE_ONE', min: 1, max: 1, sequence: 2, summary: 'Choose 1 of Punjabi, Hindi, Urdu' });
    expect(lang1.subjects.map((s) => s.subjectCode)).toEqual(['PUN', 'HIN', 'URD']);
    expect(lang2.sequence).toBe(3);

    const listed = (await t.agent.get(`${t.url}/choice-groups`).expect(200)).body.data as ChoiceGroupDTO[];
    expect(listed.map((g) => g.name)).toEqual(['Core', 'Language 1', 'Language 2']);

    // Items can change; "take all" follows its item list and CHOOSE_ONE stays 1..1.
    const grown = (await t.agent.patch(`${API}/choice-groups/${core.choiceGroupId}`).send({ subjectOfferingIds: [t.o.MATH!, t.o.SCI!] }).expect(200)).body.data;
    expect(grown.min).toBe(2);
    const shrunk = (await t.agent.patch(`${API}/choice-groups/${core.choiceGroupId}`).send({ subjectOfferingIds: [t.o.MATH!], name: 'Compulsory' }).expect(200)).body.data;
    expect(shrunk).toMatchObject({ name: 'Compulsory', min: 1, max: 1, summary: 'Take all of Mathematics' });
    expect(((await t.agent.patch(`${API}/choice-groups/${lang1.choiceGroupId}`).send({ min: 3, max: 3 }).expect(200)).body.data as ChoiceGroupDTO)).toMatchObject({ min: 1, max: 1 });
  });

  it('QA 10: CHOOSE_ONE and CHOOSE_N take their numbers from the rule type; bad numbers are refused', async () => {
    const t = await class6();
    const two = [t.o.PUN!, t.o.HIN!, t.o.URD!];

    const chooseN = await t.group({ name: 'Electives', ruleType: 'CHOOSE_N', min: 1, max: 2, subjectOfferingIds: two });
    expect(chooseN).toMatchObject({ min: 1, max: 2, summary: 'Choose 1 to 2 of Punjabi, Hindi, Urdu' });
    expect(await SubjectChoiceGroup.countDocuments({ tenantId: t.tenantId })).toBe(1);
    await t.agent.delete(`${API}/choice-groups/${chooseN.choiceGroupId}`).expect(204);

    expect(((await t.group({ name: 'Exactly two', ruleType: 'CHOOSE_N', min: 2, max: 2, subjectOfferingIds: two })).summary)).toBe('Choose 2 of Punjabi, Hindi, Urdu');
    const optional = await t.group({ name: 'Extra', ruleType: 'OPTIONAL', max: 1, subjectOfferingIds: [t.o.MATH!, t.o.SCI!] });
    expect(optional).toMatchObject({ min: 0, max: 1, summary: 'Optionally choose up to 1 of Mathematics, Science' });

    const missing = expectError(await t.post('choice-groups', { name: 'X', ruleType: 'CHOOSE_N', subjectOfferingIds: [t.o.ENG!] }), 400, 'VALIDATION_FAILED');
    expect(Object.keys(missing.details.fields).sort()).toEqual(['max', 'min']);
    expect(expectError(await t.post('choice-groups', { name: 'X', ruleType: 'CHOOSE_N', min: 3, max: 1, subjectOfferingIds: [t.o.ENG!] }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('max');
    expectError(await t.post('choice-groups', { name: 'X', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [] }), 400, 'VALIDATION_FAILED');
    expectError(await t.post('choice-groups', { name: '', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.ENG!] }), 400, 'VALIDATION_FAILED');
    expectError(await t.post('choice-groups', { name: 'X', ruleType: 'PICK_SOME', subjectOfferingIds: [t.o.ENG!] }), 400, 'VALIDATION_FAILED');
  });

  it('a subject sits in at most one group, and only subjects offered for this class can be listed', async () => {
    const t = await class6();
    await t.group({ name: 'Language 1', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.PUN!, t.o.HIN!] });

    const clash = expectError(await t.post('choice-groups', { name: 'Language 2', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.HIN!, t.o.URD!] }), 409, 'SUBJECT_IN_ANOTHER_GROUP');
    expect(clash.details.subjectOfferingIds).toEqual([t.o.HIN]);
    expect(clash.details.fields.subjectOfferingIds).toContain('Hindi');
    const second = await t.group({ name: 'Language 2', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.URD!] });
    expectError(await t.agent.patch(`${API}/choice-groups/${second.choiceGroupId}`).send({ subjectOfferingIds: [t.o.URD!, t.o.PUN!] }), 409, 'SUBJECT_IN_ANOTHER_GROUP');
    // …but a group may keep its own items when it is edited.
    await t.agent.patch(`${API}/choice-groups/${second.choiceGroupId}`).send({ subjectOfferingIds: [t.o.URD!], name: 'Second language' }).expect(200);

    // Another class's offering is out of reach.
    const [g7] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G07!]);
    const other = await offer(t.agent, g7!.classOfferingId, [t.subjects.ENG!]);
    expect(expectError(await t.post('choice-groups', { name: 'Mixed', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [other.ENG!] }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('subjectOfferingIds');
  });

  it('deleting a draft subject offering removes it from groups, constraints and programmes (and empty groups)', async () => {
    const t = await class6();
    const group = await t.group({ name: 'Languages', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.PUN!, t.o.HIN!] });
    const solo = await t.group({ name: 'Solo', ruleType: 'REQUIRED_ALL', subjectOfferingIds: [t.o.URD!] });
    await t.post('constraints', { type: 'REQUIRES', subjectOfferingId: t.o.SCI!, otherSubjectOfferingId: t.o.MATH! }).expect(201);

    await t.agent.delete(`${API}/subject-offerings/${t.o.PUN}`).expect(204);
    await t.agent.delete(`${API}/subject-offerings/${t.o.URD}`).expect(204);
    await t.agent.delete(`${API}/subject-offerings/${t.o.MATH}`).expect(204);

    const groups = (await t.agent.get(`${t.url}/choice-groups`).expect(200)).body.data as ChoiceGroupDTO[];
    expect(groups.map((g) => [g.name, g.subjects.map((s) => s.subjectCode)])).toEqual([[group.name, ['HIN']]]);
    expect(groups.some((g) => g.choiceGroupId === solo.choiceGroupId)).toBe(false);
    expect((await t.agent.get(`${t.url}/constraints`).expect(200)).body.data).toEqual([]);
  });

  it('groups are hard-deleted only in DRAFT', async () => {
    const t = await class6();
    const group = await t.group({ name: 'Language 1', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.PUN!, t.o.HIN!] });
    await forceStatus(t.tenantId, t.id, 'PUBLISHED');
    expectError(await t.agent.delete(`${API}/choice-groups/${group.choiceGroupId}`), 409, 'USE_DEACTIVATE_INSTEAD');
    expect(((await t.agent.patch(`${API}/choice-groups/${group.choiceGroupId}`).send({ status: 'INACTIVE' }).expect(200)).body.data as ChoiceGroupDTO).status).toBe('INACTIVE');
    await forceStatus(t.tenantId, t.id, 'DRAFT');
    await t.agent.delete(`${API}/choice-groups/${group.choiceGroupId}`).expect(204);
  });
});

describe('subject constraints (AS-09)', () => {
  it('QA 11: REQUIRES and EXCLUDES between two subjects of the same class', async () => {
    const t = await class6();
    const requires = (await t.post('constraints', { type: 'REQUIRES', subjectOfferingId: t.o.SCI!, otherSubjectOfferingId: t.o.MATH! }).expect(201)).body.data as ConstraintDTO;
    expect(requires).toMatchObject({ type: 'REQUIRES', subjectName: 'Science', otherSubjectName: 'Mathematics', summary: 'Science requires Mathematics' });
    const excludes = (await t.post('constraints', { type: 'EXCLUDES', subjectOfferingId: t.o.PUN!, otherSubjectOfferingId: t.o.URD! }).expect(201)).body.data as ConstraintDTO;
    expect(excludes.summary).toBe('Punjabi excludes Urdu');

    // "A requires B" differs from "B requires A", but "A excludes B" is the same rule as "B excludes A".
    await t.post('constraints', { type: 'REQUIRES', subjectOfferingId: t.o.MATH!, otherSubjectOfferingId: t.o.SCI! }).expect(201);
    expectError(await t.post('constraints', { type: 'REQUIRES', subjectOfferingId: t.o.SCI!, otherSubjectOfferingId: t.o.MATH! }), 409, 'CONSTRAINT_EXISTS');
    expectError(await t.post('constraints', { type: 'EXCLUDES', subjectOfferingId: t.o.URD!, otherSubjectOfferingId: t.o.PUN! }), 409, 'CONSTRAINT_EXISTS');

    expect(expectError(await t.post('constraints', { type: 'REQUIRES', subjectOfferingId: t.o.SCI!, otherSubjectOfferingId: t.o.SCI! }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('otherSubjectOfferingId');
    const [g7] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G07!]);
    const elsewhere = await offer(t.agent, g7!.classOfferingId, [t.subjects.HIN!]);
    expect(expectError(await t.post('constraints', { type: 'REQUIRES', subjectOfferingId: t.o.SCI!, otherSubjectOfferingId: elsewhere.HIN! }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('subjectOfferingId');
    expectError(await t.post('constraints', { type: 'MAYBE', subjectOfferingId: t.o.SCI!, otherSubjectOfferingId: t.o.MATH! }), 400, 'VALIDATION_FAILED');

    expect(((await t.agent.get(`${t.url}/constraints`).expect(200)).body.data as ConstraintDTO[]).map((c) => c.summary)).toEqual([
      'Science requires Mathematics',
      'Punjabi excludes Urdu',
      'Mathematics requires Science',
    ]);
    await t.agent.delete(`${API}/constraints/${requires.constraintId}`).expect(204);
    expectError(await t.agent.delete(`${API}/constraints/${requires.constraintId}`), 404, 'NOT_FOUND');
    expect(await SubjectChoiceConstraint.countDocuments({ tenantId: t.tenantId })).toBe(2);
  });
});

describe('impossible rules are detected (AS-14)', () => {
  it('QA 12: min above the eligible subjects, REQUIRES + EXCLUDES on one pair, and friends — each message names the rule', async () => {
    const t = await class6();
    await t.group({ name: 'Pick three languages', ruleType: 'CHOOSE_N', min: 3, max: 3, subjectOfferingIds: [t.o.PUN!, t.o.HIN!] });
    await t.post('constraints', { type: 'REQUIRES', subjectOfferingId: t.o.SCI!, otherSubjectOfferingId: t.o.MATH! }).expect(201);
    await t.post('constraints', { type: 'EXCLUDES', subjectOfferingId: t.o.MATH!, otherSubjectOfferingId: t.o.SCI! }).expect(201);

    const result = await validate(t);
    expect(result.canPublish).toBe(false);
    const tooMany = find(result, 'GROUP_MIN_EXCEEDS_ELIGIBLE');
    expect(tooMany).toHaveLength(1);
    expect(tooMany[0]).toMatchObject({ level: 'ERROR', entityType: 'subject_choice_group' });
    expect(tooMany[0]!.message).toContain('"Pick three languages"');
    expect(tooMany[0]!.message).toContain('at least 3 subjects but only 2 active subjects are available');

    const conflict = find(result, 'CONSTRAINT_CONFLICT');
    expect(conflict).toHaveLength(1); // one pair, reported once, in either direction
    expect(conflict[0]!.message).toContain('"Science requires Mathematics"');
    expect(conflict[0]!.message).toContain('"Mathematics excludes Science"');
    // Both are mandatory → the exclusion can never be met either.
    expect(find(result, 'EXCLUDES_ON_REQUIRED')[0]!.message).toContain('both subjects are mandatory');
  });

  it('flags excludes inside a "take all" group, a requires target that was deactivated, and mandatory subjects in optional groups', async () => {
    const t = await class6();
    await t.group({ name: 'Compulsory languages', ruleType: 'REQUIRED_ALL', subjectOfferingIds: [t.o.PUN!, t.o.URD!] });
    await t.post('constraints', { type: 'EXCLUDES', subjectOfferingId: t.o.PUN!, otherSubjectOfferingId: t.o.URD! }).expect(201);
    await t.post('constraints', { type: 'REQUIRES', subjectOfferingId: t.o.HIN!, otherSubjectOfferingId: t.o.ENG! }).expect(201);
    await t.group({ name: 'Core extras', ruleType: 'OPTIONAL', max: 1, subjectOfferingIds: [t.o.MATH!, t.o.SCI!] });
    await t.agent.patch(`${API}/subject-offerings/${t.o.ENG}`).send({ status: 'INACTIVE' }).expect(200);

    const result = await validate(t);
    expect(find(result, 'EXCLUDES_ON_REQUIRED')[0]!.message).toContain('same "take all" group');
    expect(find(result, 'REQUIRES_TARGET_INACTIVE')[0]!.message).toContain('"Hindi requires English"');
    const warnings = find(result, 'MANDATORY_IN_CHOICE_GROUP');
    expect(warnings.map((w) => w.level)).toEqual(['WARNING', 'WARNING']);
    expect(warnings[0]!.message).toContain('"Core extras"');
    // "Take all" never asks for more subjects than are active, so an inactive member is not an error by itself.
    await t.agent.patch(`${API}/subject-offerings/${t.o.URD}`).send({ status: 'INACTIVE' }).expect(200);
    expect(find(await validate(t), 'GROUP_MIN_EXCEEDS_ELIGIBLE')).toEqual([]);
  });

  describe('the engine on its own', () => {
    const baseline = (): ValidationInput => ({
      session: { id: 's1', startDate: '2026-04-01', endDate: '2027-03-31', locations: [{ locationId: 'L1', boardRuleVersionId: 'RV' }] },
      locations: { L1: { status: 'ACTIVE', name: 'Mohali Campus' } },
      ruleVersions: { RV: { status: 'PUBLISHED', name: '2026-27' } },
      otherSessions: [],
      classes: { G6: { code: 'G06', sequence: 9, isBoardClass: false }, G11: { code: 'G11', sequence: 14, isBoardClass: false } },
      classOfferings: [{ id: 'GO', locationId: 'L1', classId: 'G6', displayName: 'Class VI', status: 'ACTIVE' }],
      sections: [{ id: 'S1', classOfferingId: 'GO', status: 'ACTIVE' }],
      subjectOfferings: [
        { id: 'O1', classOfferingId: 'GO', subjectName: 'Maths', offeringType: 'MANDATORY', status: 'ACTIVE', subjectActive: true },
        { id: 'O2', classOfferingId: 'GO', subjectName: 'Science', offeringType: 'MANDATORY', status: 'ACTIVE', subjectActive: true },
      ],
      groups: [],
      constraints: [],
      programmes: [],
      terms: [{ id: 'T1', name: 'Term 1', locationId: null, startDate: '2026-04-01', endDate: '2026-09-30' }],
    });
    const run = (mutate: (input: ValidationInput) => void) => {
      const input = baseline();
      mutate(input);
      return validateAcademicSession(input);
    };
    const codes = (issues: ValidationIssueDTO[]) => issues.map((i) => `${i.level}:${i.code}`);

    it('a complete plan has no issues, and is a pure function of its input', () => {
      expect(validateAcademicSession(baseline())).toEqual([]);
      expect(validateAcademicSession(baseline())).toEqual(validateAcademicSession(baseline()));
    });

    it('reports every error the spec lists', () => {
      expect(codes(run((i) => (i.session.endDate = '2026-04-01')))).toContain('ERROR:SESSION_DATES_INVALID');
      expect(codes(run((i) => (i.session.locations = [])))).toContain('ERROR:SESSION_NO_LOCATIONS');
      expect(run((i) => (i.locations.L1!.status = 'INACTIVE')).find((x) => x.code === 'LOCATION_NOT_ACTIVE')?.message).toContain('Mohali Campus');
      expect(codes(run((i) => (i.ruleVersions.RV = undefined)))).toContain('ERROR:RULE_VERSION_MISSING');
      expect(codes(run((i) => (i.classOfferings = [])))).toContain('ERROR:NO_CLASS_OFFERINGS');
      expect(run((i) => (i.sections = [])).find((x) => x.code === 'CLASS_WITHOUT_SECTIONS')?.message).toBe('Class VI at Mohali Campus has no sections.');
      expect(codes(run((i) => (i.subjectOfferings = [])))).toContain('ERROR:CLASS_WITHOUT_SUBJECTS');
      expect(codes(run((i) => i.terms.push({ id: 'T9', name: 'Late', locationId: null, startDate: '2027-04-01', endDate: '2027-05-01' })))).toContain('ERROR:TERM_OUTSIDE_SESSION');
      expect(codes(run((i) => i.groups.push({ id: 'G', classOfferingId: 'GO', name: 'Bad', ruleType: 'CHOOSE_N', min: 3, max: 1, status: 'ACTIVE', subjectOfferingIds: ['O1', 'O2'] })))).toEqual(
        expect.arrayContaining(['ERROR:GROUP_MIN_GREATER_THAN_MAX', 'ERROR:GROUP_MIN_EXCEEDS_ELIGIBLE']),
      );
      expect(codes(run((i) => i.programmes.push({ id: 'P', locationId: 'L1', name: 'Science', status: 'ACTIVE', subjectRules: [{ subjectOfferingId: 'GONE' }] })))).toContain('ERROR:PROGRAMME_INACTIVE_SUBJECT');
    });

    it('warnings and info never read as errors; inactive classes are ignored', () => {
      const issues = run((i) => {
        i.otherSessions.push({ id: 'o', name: 'Last year', startDate: '2026-01-01', endDate: '2026-06-30', status: 'CLOSED' });
        i.otherSessions.push({ id: 'a', name: 'Ancient', startDate: '2026-01-01', endDate: '2026-06-30', status: 'ARCHIVED' });
        i.ruleVersions.RV = { status: 'RETIRED', name: '2025-26' };
        i.terms = [];
        i.classes.G11 = { code: 'G11', sequence: 14, isBoardClass: false };
        i.classOfferings.push({ id: 'G11O', locationId: 'L1', classId: 'G11', displayName: 'Class XI', status: 'INACTIVE' });
      });
      expect(codes(issues)).toEqual(['WARNING:RULE_VERSION_RETIRED', 'WARNING:SESSION_DATES_OVERLAP', 'WARNING:CLASS_WITHOUT_TERMS', 'INFO:NO_TERMS']);
      expect(issues.find((x) => x.code === 'SESSION_DATES_OVERLAP')?.message).toContain('Last year');

      expect(codes(run((i) => i.classOfferings.push({ id: 'G11O', locationId: 'L1', classId: 'G11', displayName: 'Class XI', status: 'ACTIVE' })))).toEqual(
        expect.arrayContaining(['ERROR:CLASS_WITHOUT_SECTIONS', 'INFO:NO_PROGRAMMES']),
      );
      // A board class never needs terms.
      expect(codes(run((i) => { i.terms = []; i.classes.G6!.isBoardClass = true; }))).toEqual(['INFO:NO_TERMS']);
    });

    it('lists errors first', () => {
      const issues = run((i) => { i.terms = []; i.sections = []; i.ruleVersions.RV = { status: 'RETIRED', name: 'old' }; });
      expect(issues.map((x) => x.level)).toEqual([...issues.map((x) => x.level)].sort((a, b) => ['ERROR', 'WARNING', 'INFO'].indexOf(a) - ['ERROR', 'WARNING', 'INFO'].indexOf(b)));
      expect(issues[0]!.level).toBe('ERROR');
    });
  });
});

describe('programmes and flexible combinations (AS-10, AS-11)', () => {
  /** Mohali: Class 9, 11 and 12; Chandigarh: Class 11. */
  async function senior() {
    const t = await draftSession();
    const more = await createMoreSubjects(t.agent);
    const [g9, g11, g12] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G09!, t.ref.classId.G11!, t.ref.classId.G12!]);
    const [chd11] = await addClasses(t.agent, t.id, t.chd.locationId, [t.ref.classId.G11!]);
    const o9 = await offer(t.agent, g9!.classOfferingId, [t.subjects.ENG!]);
    const o11 = {
      ...(await offer(t.agent, g11!.classOfferingId, [t.subjects.ENG!])),
      ...(await offer(t.agent, g11!.classOfferingId, [more.PHY!, more.CHEM!, t.subjects.MATH!, more.BIO!, more.CS!], 'ELECTIVE')),
    } as Record<string, string>;
    const o12 = await offer(t.agent, g12!.classOfferingId, [more.PHY!]);
    const oChd = await offer(t.agent, chd11!.classOfferingId, [t.subjects.ENG!]);
    const create = (body: Record<string, unknown>) =>
      t.agent.post(`${API}/academic-programmes`).send({ academicSessionId: t.id, locationId: t.moh.locationId, classFromId: t.ref.classId.G11, classToId: t.ref.classId.G12, ...body });
    return { ...t, more, g11, o9, o11, o12, oChd, create };
  }

  it('QA 13: a senior-secondary stream with required, choice and optional subjects', async () => {
    const s = await senior();
    const res = await s.create({
      name: 'Science',
      code: 'sci',
      kind: 'STREAM',
      boardId: s.ref.boardId.CBSE,
      subjectRules: [
        { subjectOfferingId: s.o11.ENG, requirement: 'REQUIRED' },
        { subjectOfferingId: s.o11.PHY, requirement: 'REQUIRED' },
        { subjectOfferingId: s.o11.CHEM, requirement: 'REQUIRED' },
        { subjectOfferingId: s.o11.MATH, requirement: 'CHOICE' },
        { subjectOfferingId: s.o11.BIO, requirement: 'CHOICE' },
        { subjectOfferingId: s.o11.CS, requirement: 'OPTIONAL' },
      ],
      choiceMin: 1,
      choiceMax: 1,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const science = res.body.data as ProgrammeDTO;
    expect(science).toMatchObject({ code: 'SCI', kind: 'STREAM', choiceMin: 1, choiceMax: 1, status: 'ACTIVE', boardId: s.ref.boardId.CBSE });
    expect(science.subjectRules.map((r) => `${r.subjectCode}:${r.requirement}`)).toEqual(['ENG:REQUIRED', 'PHY:REQUIRED', 'CHEM:REQUIRED', 'MATH:CHOICE', 'BIO:CHOICE', 'CS:OPTIONAL']);

    // A custom stream name works the same way, and omitted choice bounds default to "exactly one".
    const vocational = (await s.create({ name: 'Vocational', code: 'VOC', kind: 'STREAM', subjectRules: [{ subjectOfferingId: s.o11.CS, requirement: 'CHOICE' }, { subjectOfferingId: s.o11.MATH, requirement: 'CHOICE' }] }).expect(201)).body.data as ProgrammeDTO;
    expect(vocational).toMatchObject({ choiceMin: 1, choiceMax: 1 });

    const listed = (await s.agent.get(`${API}/academic-programmes`).query({ academicSessionId: s.id, locationId: s.moh.locationId }).expect(200)).body.data as ProgrammeDTO[];
    expect(listed.map((p) => p.code)).toEqual(['SCI', 'VOC']);
    expect((await s.agent.get(`${API}/academic-programmes`).query({ academicSessionId: s.id, locationId: s.chd.locationId }).expect(200)).body.data).toEqual([]);

    const patched = (await s.agent.patch(`${API}/academic-programmes/${science.programmeId}`).send({ name: 'Science (PCM/PCB)', choiceMax: 2 }).expect(200)).body.data;
    expect(patched).toMatchObject({ name: 'Science (PCM/PCB)', choiceMin: 1, choiceMax: 2 });
  });

  it('subjects must be offered at the programme’s location, inside its class range, and listed once', async () => {
    const s = await senior();
    const stream = (rules: unknown[], extra: Record<string, unknown> = {}) => s.create({ name: 'S', code: 'X1', kind: 'STREAM', subjectRules: rules, ...extra });
    const rule = (id: string | undefined, requirement = 'REQUIRED') => ({ subjectOfferingId: id, requirement });

    expect(expectError(await stream([rule(s.o9.ENG)]), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty(['subjectRules.0.subjectOfferingId']); // Class 9 is outside XI–XII
    expect(expectError(await stream([rule(s.oChd.ENG)]), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty(['subjectRules.0.subjectOfferingId']); // another location
    expect(expectError(await stream([rule(s.o11.ENG), rule(s.o11.ENG, 'OPTIONAL')]), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('subjectRules');
    expect(expectError(await stream([rule(s.o11.MATH, 'CHOICE')], { choiceMin: 1, choiceMax: 2 }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('choiceMax');
    expect(expectError(await stream([rule(s.o11.MATH, 'CHOICE'), rule(s.o11.BIO, 'CHOICE')], { choiceMin: 2, choiceMax: 1 }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('choiceMax');
    expect(expectError(await stream([rule(s.o11.ENG)], { classFromId: s.ref.classId.G12, classToId: s.ref.classId.G11 }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('classToId');
    expectError(await stream([rule(s.o11.ENG)], { locationId: s.pkl.locationId }), 409, 'LOCATION_NOT_IN_SESSION');
    expectError(await stream([rule(s.o11.ENG)], { boardId: '6f0b3e0a-1f2e-4d5b-8c1a-0a1b2c3d4e5f' }), 404, 'NOT_FOUND');
    expectError(await stream([rule(s.o11.ENG)], { academicSessionId: '6f0b3e0a-1f2e-4d5b-8c1a-0a1b2c3d4e5f' }), 404, 'NOT_FOUND');
    // A range that includes both classes accepts a Class 12 subject too.
    await stream([rule(s.o11.ENG), rule(s.o12.PHY)]).expect(201);
    expectError(await stream([rule(s.o11.ENG)]), 409, 'PROGRAMME_CODE_TAKEN');
  });

  it('a stream that uses a deactivated subject is caught by validation', async () => {
    const s = await senior();
    await s.create({ name: 'Science', code: 'SCI', kind: 'STREAM', subjectRules: [{ subjectOfferingId: s.o11.PHY, requirement: 'REQUIRED' }] }).expect(201);
    await s.agent.patch(`${API}/subject-offerings/${s.o11.PHY}`).send({ status: 'INACTIVE' }).expect(200);
    const issue = find(await validate(s), 'PROGRAMME_INACTIVE_SUBJECT')[0]!;
    expect(issue).toMatchObject({ level: 'ERROR', entityType: 'academic_programme' });
    expect(issue.message).toContain('Programme "Science" uses inactive subjects: Physics');
  });

  it('programmes are hard-deleted only in DRAFT', async () => {
    const s = await senior();
    const p = (await s.create({ name: 'Flex', code: 'FLEX', kind: 'FLEXIBLE', subjectRules: [] }).expect(201)).body.data as ProgrammeDTO;
    await forceStatus(s.tenantId, s.id, 'PUBLISHED');
    expectError(await s.agent.delete(`${API}/academic-programmes/${p.programmeId}`), 409, 'USE_DEACTIVATE_INSTEAD');
    expect((await s.agent.patch(`${API}/academic-programmes/${p.programmeId}`).send({ status: 'INACTIVE' }).expect(200)).body.data.status).toBe('INACTIVE');
    await forceStatus(s.tenantId, s.id, 'DRAFT');
    await s.agent.delete(`${API}/academic-programmes/${p.programmeId}`).expect(204);
  });

  it('QA 14: a flexible combination has no fixed subject list — the class’s groups and constraints define what is allowed', async () => {
    const s = await senior();
    expect(expectError(await s.create({ name: 'Flex', code: 'FLEX', kind: 'FLEXIBLE', subjectRules: [{ subjectOfferingId: s.o11.ENG, requirement: 'REQUIRED' }] }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('subjectRules');
    const flex = (await s.create({ name: 'Flexible Combination', code: 'FLEX', kind: 'FLEXIBLE', choiceMin: 2, choiceMax: 3 }).expect(201)).body.data as ProgrammeDTO;
    expect(flex).toMatchObject({ kind: 'FLEXIBLE', subjectRules: [], choiceMin: null, choiceMax: null });
    await s.create({ name: 'Science', code: 'SCI', kind: 'STREAM', classToId: s.ref.classId.G11, subjectRules: [{ subjectOfferingId: s.o11.PHY, requirement: 'REQUIRED' }] }).expect(201);

    // The rules a flexible student picks within live on the class.
    const g11Url = `${API}/class-offerings/${s.g11!.classOfferingId}`;
    await s.agent.post(`${g11Url}/choice-groups`).send({ name: 'Electives', ruleType: 'CHOOSE_N', min: 1, max: 3, subjectOfferingIds: [s.o11.MATH, s.o11.BIO, s.o11.CS] }).expect(201);
    await s.agent.post(`${g11Url}/constraints`).send({ type: 'EXCLUDES', subjectOfferingId: s.o11.BIO, otherSubjectOfferingId: s.o11.CS }).expect(201);

    const context = (classId: string) => s.agent.get(`${API}/academic-context`).query({ academicSessionId: s.id, locationId: s.moh.locationId, classId });
    const g11 = (await context(s.ref.classId.G11!).expect(200)).body.data;
    expect(g11.programmes.map((p: ProgrammeDTO) => p.code)).toEqual(['FLEX', 'SCI']);
    expect(g11.choiceGroups.map((g: ChoiceGroupDTO) => g.summary)).toEqual(['Choose 1 to 3 of Mathematics, Biology, Computer Science']);
    expect(g11.constraints.map((c: ConstraintDTO) => c.summary)).toEqual(['Biology excludes Computer Science']);
    // Class XII is inside Flexible's range but outside Science's; Class 9 is in neither.
    expect((await context(s.ref.classId.G12!).expect(200)).body.data.programmes.map((p: ProgrammeDTO) => p.code)).toEqual(['FLEX']);
    expect((await context(s.ref.classId.G09!).expect(200)).body.data.programmes).toEqual([]);
  });
});

const act = (t: DraftSession, action: string, id = t.id) => t.agent.post(`${API}/academic-sessions/${id}/${action}`);
const sessionOf = (t: DraftSession, id = t.id) => get<AcademicSessionDTO>(t, `/academic-sessions/${id}`);
const clone = (t: DraftSession, body: Record<string, unknown> = {}, id = t.id) =>
  t.agent.post(`${API}/academic-sessions/${id}/clone`).send({ name: 'Academic Year 2027-28', code: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31', ...body });

/** A complete plan: Class 6 at Mohali with two sections, three subjects (one with a CBSE code), a group, a rule, a programme and two terms. */
async function rich() {
  const t = await draftSession();
  await t.agent.put(`${API}/subjects/${t.subjects.MATH}/board-codes`).send({ boardRuleVersionId: t.ref.ruleVersionId('CBSE'), boardSubjectCode: '041' }).expect(200);
  const [g6] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G06!]);
  const classOfferingId = g6!.classOfferingId;
  const sections = (await t.agent.post(`${API}/class-offerings/${classOfferingId}/sections`).send({ codes: ['A', 'B'] }).expect(201)).body.data as { sectionOfferingId: string }[];
  const o = await offer(t.agent, classOfferingId, [t.subjects.MATH!, t.subjects.SCI!, t.subjects.ENG!], 'ELECTIVE');
  const group = (await t.agent.post(`${API}/class-offerings/${classOfferingId}/choice-groups`).send({ name: 'Electives', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [o.MATH, o.SCI] }).expect(201)).body.data;
  const constraint = (await t.agent.post(`${API}/class-offerings/${classOfferingId}/constraints`).send({ type: 'REQUIRES', subjectOfferingId: o.SCI, otherSubjectOfferingId: o.ENG }).expect(201)).body.data;
  const programme = (
    await t.agent
      .post(`${API}/academic-programmes`)
      .send({ academicSessionId: t.id, locationId: t.moh.locationId, name: 'Class 6 track', code: 'P6', kind: 'STREAM', classFromId: t.ref.classId.G06, classToId: t.ref.classId.G06, subjectRules: [{ subjectOfferingId: o.MATH, requirement: 'REQUIRED' }] })
      .expect(201)
  ).body.data;
  const term1 = (await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'Term 1', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201)).body.data;
  const term2 = (await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'Term 2', code: 'T2', startDate: '2026-10-01', endDate: '2027-03-31' }).expect(201)).body.data;
  return {
    ...t,
    classOfferingId,
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
    expect(empty.issues.map((i) => i.code)).toContain('NO_CLASS_OFFERINGS');
    expect(empty.summary.errors).toBeGreaterThan(0);
    expect((await sessionOf(t)).lastValidation).toMatchObject({ errors: empty.summary.errors, warnings: empty.summary.warnings });

    // Publishing re-runs validation and refuses, naming every error.
    const blocked = expectError(await act(t, 'publish'), 400, 'VALIDATION_FAILED');
    expect(blocked.message).toMatch(/^Fix \d+ errors? before you publish/);
    expect((blocked.details as unknown as { issues: { level: string; code: string }[] }).issues.filter((i) => i.level === 'ERROR').map((i) => i.code)).toContain('NO_CLASS_OFFERINGS');
    expect((await sessionOf(t)).status).toBe('DRAFT');

    const plan = await makePublishable(t);
    const clean = (await act(t, 'validate').expect(200)).body.data as ValidationResultDTO;
    expect(clean).toMatchObject({ canPublish: true, summary: { errors: 0, warnings: 0, info: 0 } });
    expect((await sessionOf(t)).lastValidation).toMatchObject({ errors: 0 });

    // Warnings and info never block: without terms the plan still publishes.
    await t.agent.delete(`${API}/terms/${plan.termId}`).expect(204);
    const noTerms = (await act(t, 'validate').expect(200)).body.data as ValidationResultDTO;
    expect(noTerms.canPublish).toBe(true);
    expect(noTerms.issues.map((i) => `${i.level}:${i.code}`)).toEqual(['WARNING:CLASS_WITHOUT_TERMS', 'INFO:NO_TERMS']);

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
      'POST class': t.agent.post(`${t.sessionUrl}/class-offerings`).send({ locationId: t.moh.locationId, classIds: [t.ref.classId.G07!] }),
      'PATCH class': t.agent.patch(`${API}/class-offerings/${t.classOfferingId}`).send({ displayName: 'x' }),
      'POST section': t.agent.post(`${API}/class-offerings/${t.classOfferingId}/sections`).send({ codes: ['Z'] }),
      'PATCH subject offering': t.agent.patch(`${API}/subject-offerings/${t.o.MATH}`).send({ offeringType: 'MANDATORY' }),
      'POST group': t.agent.post(`${API}/class-offerings/${t.classOfferingId}/choice-groups`).send({ name: 'x', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.ENG] }),
      'PATCH group': t.agent.patch(`${API}/choice-groups/${t.groupId}`).send({ name: 'x' }),
      'DELETE group': t.agent.delete(`${API}/choice-groups/${t.groupId}`),
      'POST constraint': t.agent.post(`${API}/class-offerings/${t.classOfferingId}/constraints`).send({ type: 'EXCLUDES', subjectOfferingId: t.o.MATH, otherSubjectOfferingId: t.o.ENG }),
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
    expect(await get<unknown[]>(t, `/academic-sessions/${t.id}/class-offerings`)).toHaveLength(1);
    expect(await get<unknown[]>(t, `/class-offerings/${t.classOfferingId}/choice-groups`)).toHaveLength(1);
    expect(await get<unknown[]>(t, `/academic-programmes?academicSessionId=${t.id}`)).toHaveLength(1);
    expect(await get<unknown[]>(t, `/academic-sessions/${t.id}/terms`)).toHaveLength(2);
    expect(await ClassOffering.countDocuments({ tenantId: t.tenantId, sessionId: t.id })).toBe(1);
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
      entityTypes: ['class_offering', 'section_offering', 'subject_offering', 'academic_term', 'session_location', 'choice_group', 'constraint', 'programme'],
      count: async ({ entityId }) => (inUse.has(entityId) ? 3 : 0),
      message: (n) => `${n} faculty assignments use this.`,
    });
  }

  it('QA 17: deactivating or removing structure is refused when downstream records use it; the same change is fine on a DRAFT', async () => {
    const t = await rich();
    registerStub();
    try {
      for (const id of [t.classOfferingId, ...t.sectionIds, t.o.MATH!, t.groupId, t.constraintId, t.programmeId, ...t.termIds, t.moh.locationId, t.chd.locationId]) inUse.add(id);

      // DRAFT: nothing downstream can exist yet, so the guard stays out of the way.
      const draftChange = await t.agent.patch(`${API}/sections/${t.sectionIds[1]}`).send({ status: 'INACTIVE' }).expect(200);
      expect(draftChange.body.data.status).toBe('INACTIVE');
      await t.agent.patch(`${API}/sections/${t.sectionIds[1]}`).send({ status: 'ACTIVE' }).expect(200);

      await activate(t);
      const before = await auditForSession(t.agent, t.id);

      const blocked: [string, ReturnType<typeof t.agent.patch>][] = [
        ['class offering', t.agent.patch(`${API}/class-offerings/${t.classOfferingId}`).send({ status: 'INACTIVE' })],
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
      await t.agent.post(`${API}/class-offerings/${t.classOfferingId}/sections`).send({ codes: ['C'] }).expect(201);
      const [g7] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G07!]);
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
    const countsBefore = await Promise.all([ClassOffering, SectionOffering, SubjectOffering, SubjectChoiceGroup, SubjectChoiceConstraint, AcademicProgramme, AcademicTerm].map((m) => (m as typeof ClassOffering).countDocuments({ tenantId: t.tenantId, sessionId: t.id })));

    const res = await clone(t);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const copy = res.body.data as AcademicSessionDTO;
    const copyUrl = `/academic-sessions/${copy.academicSessionId}`;
    expect(copy).toMatchObject({ status: 'DRAFT', code: '2027-28', name: 'Academic Year 2027-28', previousSessionId: t.id, startDate: '2027-04-01', endDate: '2028-03-31', isCurrent: false });
    expect(copy.academicSessionId).not.toBe(t.id);
    expect(copy.locations.map((l) => `${l.locationCode}:${l.boardCode}:${l.ruleVersionName}:${l.affiliationNumber}`)).toEqual(['MOH:CBSE:2026-27:1630457', 'CHD:PSEB:2026-27:null']);

    // Structure came across with NEW ids.
    const classes = await get<{ classOfferingId: string; displayName: string; sectionCount: number; subjectCount: number }[]>(t, `${copyUrl}/class-offerings`);
    expect(classes).toMatchObject([{ displayName: 'Class 6', sectionCount: 1, subjectCount: 3 }]); // section B was inactive
    expect(classes[0]!.classOfferingId).not.toBe(t.classOfferingId);
    const newClass = classes[0]!.classOfferingId;
    const sections = await get<{ sectionCode: string; sectionOfferingId: string }[]>(t, `/class-offerings/${newClass}/sections`);
    expect(sections.map((s) => s.sectionCode)).toEqual(['A']);
    expect(t.sectionIds).not.toContain(sections[0]!.sectionOfferingId);
    const offerings = await get<{ subjectOfferingId: string; subjectCode: string; boardSubjectCode: string | null }[]>(t, `/class-offerings/${newClass}/subjects`);
    expect(offerings.map((o) => o.subjectCode).sort()).toEqual(['ENG', 'MATH', 'SCI']);
    expect(offerings.find((o) => o.subjectCode === 'MATH')?.boardSubjectCode).toBe('041'); // board code mapping travels with the pinned rule version
    const oldIds = Object.values(t.o);
    expect(offerings.some((o) => oldIds.includes(o.subjectOfferingId))).toBe(false);

    // Rules point at the NEW offerings.
    const newId = (code: string) => offerings.find((o) => o.subjectCode === code)!.subjectOfferingId;
    const groups = await get<{ name: string; ruleType: string; subjects: { subjectOfferingId: string }[] }[]>(t, `/class-offerings/${newClass}/choice-groups`);
    expect(groups).toMatchObject([{ name: 'Electives', ruleType: 'CHOOSE_ONE' }]);
    expect(groups[0]!.subjects.map((s) => s.subjectOfferingId).sort()).toEqual([newId('MATH'), newId('SCI')].sort());
    const constraints = await get<{ subjectOfferingId: string; otherSubjectOfferingId: string; type: string }[]>(t, `/class-offerings/${newClass}/constraints`);
    expect(constraints).toMatchObject([{ type: 'REQUIRES', subjectOfferingId: newId('SCI'), otherSubjectOfferingId: newId('ENG') }]);
    const programmes = await get<{ code: string; subjectRules: { subjectOfferingId: string }[] }[]>(t, `/academic-programmes?academicSessionId=${copy.academicSessionId}`);
    expect(programmes).toMatchObject([{ code: 'P6', subjectRules: [{ subjectOfferingId: newId('MATH') }] }]);

    // Terms move by the difference between the two start dates (365 days here; 2028 is a leap year, so the last day lands on 30 March).
    const terms = await get<AcademicTermDTO[]>(t, `${copyUrl}/terms`);
    expect(terms.map((x) => [x.code, x.startDate, x.endDate])).toEqual([
      ['T1', '2027-04-01', '2027-09-30'],
      ['T2', '2027-10-01', '2028-03-30'],
    ]);

    // The clone is a normal draft that validates, and the original did not move.
    expect(((await act(t, 'validate', copy.academicSessionId).expect(200)).body.data as ValidationResultDTO).canPublish).toBe(true);
    const { lastValidation: _a, updatedAt: _b, ...originalNow } = await sessionOf(t);
    const { lastValidation: _c, updatedAt: _d, ...originalBefore } = original;
    expect(originalNow).toEqual(originalBefore);
    const countsAfter = await Promise.all([ClassOffering, SectionOffering, SubjectOffering, SubjectChoiceGroup, SubjectChoiceConstraint, AcademicProgramme, AcademicTerm].map((m) => (m as typeof ClassOffering).countDocuments({ tenantId: t.tenantId, sessionId: t.id })));
    expect(countsAfter).toEqual(countsBefore);

    const event = (await auditForSession(t.agent, copy.academicSessionId)).find((e) => e.action === 'academic_session.cloned')!;
    expect(event.metadata).toMatchObject({ clonedFromSessionId: t.id, termShiftDays: 365, copied: { classOfferings: 1, sections: 1, subjectOfferings: 3, choiceGroups: 1, constraints: 1, programmes: 1, terms: 2 } });
  });

  it('refuses a taken code or bad dates, needs the publish permission, and starts from any visible session', async () => {
    const t = await rich();
    expectError(await clone(t, { code: '2026-27' }), 409, 'SESSION_CODE_TAKEN');
    expectError(await clone(t, { startDate: '2028-04-01', endDate: '2027-04-01' }), 400, 'SESSION_DATES_INVALID');
    expect(expectError(await clone(t, { startDate: 'soon' }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('startDate');
    expectError(await clone(t, {}, '6f0b3e0a-1f2e-4d5b-8c1a-0a1b2c3d4e5f'), 404, 'NOT_FOUND');
    expect(await AcademicSession.countDocuments({ tenantId: t.tenantId })).toBe(1); // nothing half-created
    expect(await ClassOffering.countDocuments({ tenantId: t.tenantId })).toBe(1);

    const faculty = await createUserAndLogin(t.tenantId, 'FACULTY');
    expectError(await faculty.agent.post(`${t.sessionUrl}/clone`).send({ name: 'x', code: 'X1', startDate: '2027-04-01', endDate: '2028-03-31' }), 403, 'FORBIDDEN');
  });
});

describe('overview, academic context and current session (AS-16, AS-18)', () => {
  it('the overview reports counts, boards and a checklist that follows the plan', async () => {
    const t = await draftSession();
    const empty = await get<AcademicOverviewDTO>(t, `/academic-sessions/${t.id}/overview`);
    expect(empty.counts).toEqual({ locations: 2, classes: 0, sections: 0, subjects: 0, programmes: 0, terms: 0, choiceGroups: 0 });
    expect(empty.boards.map((b) => `${b.locationCode}:${b.boardCode}`)).toEqual(['MOH:CBSE', 'CHD:PSEB']);
    const status = (o: AcademicOverviewDTO) => Object.fromEntries(o.checklist.map((c) => [c.key, c.status]));
    expect(status(empty)).toEqual({ session: 'completed', board: 'completed', classes: 'pending', sections: 'pending', subjects: 'pending', rules: 'optional', terms: 'optional', validation: 'pending' });

    const full = await rich();
    await act(full, 'validate').expect(200);
    const o = await get<AcademicOverviewDTO>(full, `/academic-sessions/${full.id}/overview`);
    expect(o.counts).toEqual({ locations: 2, classes: 1, sections: 2, subjects: 3, programmes: 1, terms: 2, choiceGroups: 1 });
    expect(status(o)).toEqual({ session: 'completed', board: 'completed', classes: 'completed', sections: 'completed', subjects: 'completed', rules: 'completed', terms: 'completed', validation: 'completed' });
    expect(o.lastValidation).toMatchObject({ errors: 0 });

    const faculty = await createUserAndLogin(full.tenantId, 'FACULTY');
    expectError(await faculty.agent.get(`${full.sessionUrl}/overview`), 403, 'FORBIDDEN');
  });

  it('AS-18: the context lists a location’s classes, or returns the whole tree for one class', async () => {
    const t = await rich();
    await activate(t);
    const query = (extra: Record<string, string> = {}) => t.agent.get(`${API}/academic-context`).query({ academicSessionId: t.id, locationId: t.moh.locationId, ...extra });

    const list = (await query().expect(200)).body.data as AcademicContextClassesDTO;
    expect(list).toMatchObject({ sessionStatus: 'ACTIVE', board: { boardCode: 'CBSE', ruleVersionName: '2026-27' } });
    expect(list.classes.map((g) => g.displayName)).toEqual(['Class 6']);
    expect(list).not.toHaveProperty('sections');

    const tree = (await query({ classId: t.ref.classId.G06! }).expect(200)).body.data as AcademicContextDTO;
    expect(tree.classOffering).toMatchObject({ classOfferingId: t.classOfferingId, canonicalCode: 'G06' });
    expect(tree.sections.map((s) => s.sectionCode)).toEqual(['A', 'B']);
    expect(tree.subjectOfferings.map((s) => `${s.subjectCode}:${s.boardSubjectCode}`).sort()).toEqual(['ENG:null', 'MATH:041', 'SCI:null']);
    expect(tree.choiceGroups.map((g) => g.summary)).toEqual(['Choose 1 of Mathematics, Science']);
    expect(tree.constraints.map((c) => c.summary)).toEqual(['Science requires English']);
    expect(tree.programmes.map((p) => p.code)).toEqual(['P6']);
    expect(tree.terms.map((x) => x.code)).toEqual(['T1', 'T2']);

    expectError(await query({ locationId: t.pkl.locationId }), 409, 'LOCATION_NOT_IN_SESSION');
    expectError(await query({ classId: t.ref.classId.G07! }), 404, 'NOT_FOUND');
    expect(expectError(await t.agent.get(`${API}/academic-context`).query({ academicSessionId: t.id }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('locationId');
  });

  it('Faculty and Staff read the context for PUBLISHED, ACTIVE and CLOSED sessions only; Parents get nothing', async () => {
    const t = await rich();
    const draftCopy = (await clone(t).expect(201)).body.data as AcademicSessionDTO;
    const faculty = await createUserAndLogin(t.tenantId, 'FACULTY');
    const staff = await createUserAndLogin(t.tenantId, 'STAFF');
    const parent = await createUserAndLogin(t.tenantId, 'PARENT');
    const ask = (agent: typeof faculty.agent, academicSessionId: string) =>
      agent.get(`${API}/academic-context`).query({ academicSessionId, locationId: t.moh.locationId, classId: t.ref.classId.G06! });

    for (const user of [faculty, staff]) {
      expectError(await ask(user.agent, t.id), 404, 'NOT_FOUND'); // still a draft
      expectError(await user.agent.get(`${API}/academic-sessions/current`), 404, 'NOT_FOUND');
    }
    await activate(t);
    for (const user of [faculty, staff]) {
      expect((await ask(user.agent, t.id).expect(200)).body.data.classOffering.classOfferingId).toBe(t.classOfferingId);
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
  /** A dev-only fake "faculty assignment" module: it resolves Location → Session → Class → Section → Subject, stores only offering ids, and registers itself as a dependency. */
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
        classOffering: { classOfferingId: t.classOfferingId, displayName: 'Class 6' },
        section: { sectionOfferingId: sectionA, sectionCode: 'A' },
      });
      expect(await academicService.assertSubjectOfferingUsable(t.ctx, t.o.MATH!, { purpose: 'NEW_ASSIGNMENT' })).toMatchObject({
        subjectOffering: { subjectOfferingId: t.o.MATH, subjectName: 'Mathematics', offeringType: 'ELECTIVE' },
        classOffering: { displayName: 'Class 6' },
      });
      // The context call is the same data the HTTP route serves.
      const context = (await academicService.getContext(t.ctx, { academicSessionId: t.id, locationId: t.moh.locationId, classId: t.ref.classId.G06! })) as AcademicContextDTO;
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

  it('an inactive class or subject refuses new assignments but stays readable', async () => {
    const t = await rich();
    await activate(t);
    await t.agent.patch(`${API}/subject-offerings/${t.o.ENG}`).send({ status: 'INACTIVE' }).expect(200);
    await expect(academicService.assertSubjectOfferingUsable(t.ctx, t.o.ENG!, { purpose: 'NEW_ASSIGNMENT' })).rejects.toMatchObject({ details: { reason: 'SUBJECT_INACTIVE' } });
    expect(await academicService.assertSubjectOfferingUsable(t.ctx, t.o.ENG!, { purpose: 'HISTORICAL_READ' })).toMatchObject({ subjectOffering: { subjectName: 'English' } });
    await t.agent.patch(`${API}/class-offerings/${t.classOfferingId}`).send({ status: 'INACTIVE' }).expect(200);
    await expect(academicService.assertSectionUsable(t.ctx, t.sectionIds[0]!, { purpose: 'NEW_ASSIGNMENT' })).rejects.toMatchObject({ details: { reason: 'CLASS_INACTIVE' } });
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
    expect(by('programme.updated')[0]!.changes).toEqual([{ field: 'name', from: 'Class 6 track', to: 'Track 6' }]);
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
  it('seeds Greenfield with an ACTIVE 2026-27 session, a cloned 2027-28 (published for promotion), and a full academic context', async () => {
    await seedDemo({ quiet: true });
    const admin = request.agent(app);
    await admin.post(`${API}/auth/login`).send({ email: 'admin@greenfield.demo', password: 'Welcome@123' }).expect(200);

    const sessions = (await admin.get(`${API}/academic-sessions`).expect(200)).body.data as AcademicSessionDTO[];
    expect(sessions.map((s) => `${s.code}:${s.status}`)).toEqual(['2027-28:PUBLISHED', '2026-27:ACTIVE']); // Module 4 Part 3 publishes the clone so promotion can be tried
    const active = sessions.find((s) => s.status === 'ACTIVE')!;
    const next = sessions.find((s) => s.status === 'PUBLISHED')!;
    expect(active.locations.map((l) => `${l.locationCode}:${l.boardCode}`)).toEqual(['MOH:CBSE', 'CHD:STATE_TEST']);
    expect(next.previousSessionId).toBe(active.academicSessionId);

    const [moh, chd] = active.locations.map((l) => l.locationId) as [string, string];
    const classes = (await admin.get(`${API}/classes`).expect(200)).body.data as { classId: string; canonicalCode: string }[];
    const classId = (code: string) => classes.find((g) => g.canonicalCode === code)!.classId;
    const context = async (locationId: string, extra: Record<string, string> = {}) =>
      (await admin.get(`${API}/academic-context`).query({ academicSessionId: active.academicSessionId, locationId, ...extra }).expect(200)).body.data;

    expect((await context(moh)).classes).toHaveLength(14); // Nursery–XII
    expect((await context(chd)).classes).toHaveLength(10); // Nursery–VIII
    for (const location of [moh, chd]) expect((await context(location, { classId: classId('G08') })).sections.map((s: { sectionCode: string }) => s.sectionCode)).toEqual(['A', 'B', 'C']);

    const g6 = (await context(moh, { classId: classId('G06') })) as AcademicContextDTO;
    expect(g6.choiceGroups.map((g) => `${g.name}: ${g.summary}`)).toEqual([
      'Core: Take all of Mathematics, Science, Social Science, Physical Education',
      'Language 1: Choose 1 of Punjabi, Hindi, Urdu',
      'Language 2: Take all of English',
    ]);
    const g11 = (await context(moh, { classId: classId('G11') })) as AcademicContextDTO;
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
