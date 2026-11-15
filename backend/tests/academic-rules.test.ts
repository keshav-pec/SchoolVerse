import { beforeEach, describe, expect, it } from 'vitest';
import type { ChoiceGroupDTO, ConstraintDTO, ProgrammeDTO, ValidationIssueDTO, ValidationResultDTO } from '@shared';
import { validateAcademicSession, type ValidationInput } from '../src/modules/academic/validation';
import { SubjectChoiceConstraint, SubjectChoiceGroup } from '../src/modules/academic/rules.model';
import {
  addGrades,
  API,
  createMoreSubjects,
  draftSession,
  expectError,
  forceStatus,
  loadReference,
  offer,
  useTestDatabase,
  type DraftSession,
} from './helpers';

useTestDatabase();
beforeEach(async () => {
  await loadReference();
});

/** Grade 6 at Mohali offering English, Hindi, Punjabi, Urdu, Mathematics and Science. */
async function grade6() {
  const t = await draftSession();
  const more = await createMoreSubjects(t.agent);
  const [g] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G06!]);
  const url = `${API}/grade-offerings/${g!.gradeOfferingId}`;
  const core = await offer(t.agent, g!.gradeOfferingId, [t.subjects.MATH!, t.subjects.SCI!, t.subjects.ENG!]);
  const languages = await offer(t.agent, g!.gradeOfferingId, [more.PUN!, t.subjects.HIN!, more.URD!], 'LANGUAGE');
  const o = { ...core, ...languages } as Record<string, string>;
  const group = async (body: Record<string, unknown>) => (await t.agent.post(`${url}/choice-groups`).send(body).expect(201)).body.data as ChoiceGroupDTO;
  const post = (path: string, body: Record<string, unknown>) => t.agent.post(`${url}/${path}`).send(body);
  return { ...t, more, url, gradeOfferingId: g!.gradeOfferingId, o, group, post };
}

const validate = async (t: DraftSession) => (await t.agent.post(`${t.sessionUrl}/validate`).expect(200)).body.data as ValidationResultDTO;
const find = (r: ValidationResultDTO, code: string) => r.issues.filter((i) => i.code === code);

describe('subject choice groups (AS-08)', () => {
  it('QA 9: a language group is just data — Core, Language 1 (choose one of Punjabi / Hindi / Urdu), Language 2', async () => {
    const t = await grade6();
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
    const t = await grade6();
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

  it('a subject sits in at most one group, and only subjects offered for this grade can be listed', async () => {
    const t = await grade6();
    await t.group({ name: 'Language 1', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.PUN!, t.o.HIN!] });

    const clash = expectError(await t.post('choice-groups', { name: 'Language 2', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.HIN!, t.o.URD!] }), 409, 'SUBJECT_IN_ANOTHER_GROUP');
    expect(clash.details.subjectOfferingIds).toEqual([t.o.HIN]);
    expect(clash.details.fields.subjectOfferingIds).toContain('Hindi');
    const second = await t.group({ name: 'Language 2', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.URD!] });
    expectError(await t.agent.patch(`${API}/choice-groups/${second.choiceGroupId}`).send({ subjectOfferingIds: [t.o.URD!, t.o.PUN!] }), 409, 'SUBJECT_IN_ANOTHER_GROUP');
    // …but a group may keep its own items when it is edited.
    await t.agent.patch(`${API}/choice-groups/${second.choiceGroupId}`).send({ subjectOfferingIds: [t.o.URD!], name: 'Second language' }).expect(200);

    // Another grade's offering is out of reach.
    const [g7] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G07!]);
    const other = await offer(t.agent, g7!.gradeOfferingId, [t.subjects.ENG!]);
    expect(expectError(await t.post('choice-groups', { name: 'Mixed', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [other.ENG!] }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('subjectOfferingIds');
  });

  it('deleting a draft subject offering removes it from groups, constraints and programmes (and empty groups)', async () => {
    const t = await grade6();
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
    const t = await grade6();
    const group = await t.group({ name: 'Language 1', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [t.o.PUN!, t.o.HIN!] });
    await forceStatus(t.tenantId, t.id, 'PUBLISHED');
    expectError(await t.agent.delete(`${API}/choice-groups/${group.choiceGroupId}`), 409, 'USE_DEACTIVATE_INSTEAD');
    expect(((await t.agent.patch(`${API}/choice-groups/${group.choiceGroupId}`).send({ status: 'INACTIVE' }).expect(200)).body.data as ChoiceGroupDTO).status).toBe('INACTIVE');
    await forceStatus(t.tenantId, t.id, 'DRAFT');
    await t.agent.delete(`${API}/choice-groups/${group.choiceGroupId}`).expect(204);
  });
});

describe('subject constraints (AS-09)', () => {
  it('QA 11: REQUIRES and EXCLUDES between two subjects of the same grade', async () => {
    const t = await grade6();
    const requires = (await t.post('constraints', { type: 'REQUIRES', subjectOfferingId: t.o.SCI!, otherSubjectOfferingId: t.o.MATH! }).expect(201)).body.data as ConstraintDTO;
    expect(requires).toMatchObject({ type: 'REQUIRES', subjectName: 'Science', otherSubjectName: 'Mathematics', summary: 'Science requires Mathematics' });
    const excludes = (await t.post('constraints', { type: 'EXCLUDES', subjectOfferingId: t.o.PUN!, otherSubjectOfferingId: t.o.URD! }).expect(201)).body.data as ConstraintDTO;
    expect(excludes.summary).toBe('Punjabi excludes Urdu');

    // "A requires B" differs from "B requires A", but "A excludes B" is the same rule as "B excludes A".
    await t.post('constraints', { type: 'REQUIRES', subjectOfferingId: t.o.MATH!, otherSubjectOfferingId: t.o.SCI! }).expect(201);
    expectError(await t.post('constraints', { type: 'REQUIRES', subjectOfferingId: t.o.SCI!, otherSubjectOfferingId: t.o.MATH! }), 409, 'CONSTRAINT_EXISTS');
    expectError(await t.post('constraints', { type: 'EXCLUDES', subjectOfferingId: t.o.URD!, otherSubjectOfferingId: t.o.PUN! }), 409, 'CONSTRAINT_EXISTS');

    expect(expectError(await t.post('constraints', { type: 'REQUIRES', subjectOfferingId: t.o.SCI!, otherSubjectOfferingId: t.o.SCI! }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('otherSubjectOfferingId');
    const [g7] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G07!]);
    const elsewhere = await offer(t.agent, g7!.gradeOfferingId, [t.subjects.HIN!]);
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
    const t = await grade6();
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
    const t = await grade6();
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
      grades: { G6: { code: 'G06', sequence: 9, isBoardGrade: false }, G11: { code: 'G11', sequence: 14, isBoardGrade: false } },
      gradeOfferings: [{ id: 'GO', locationId: 'L1', gradeId: 'G6', displayName: 'Class VI', status: 'ACTIVE' }],
      sections: [{ id: 'S1', gradeOfferingId: 'GO', status: 'ACTIVE' }],
      subjectOfferings: [
        { id: 'O1', gradeOfferingId: 'GO', subjectName: 'Maths', offeringType: 'MANDATORY', status: 'ACTIVE', subjectActive: true },
        { id: 'O2', gradeOfferingId: 'GO', subjectName: 'Science', offeringType: 'MANDATORY', status: 'ACTIVE', subjectActive: true },
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
      expect(codes(run((i) => (i.gradeOfferings = [])))).toContain('ERROR:NO_GRADE_OFFERINGS');
      expect(run((i) => (i.sections = [])).find((x) => x.code === 'GRADE_WITHOUT_SECTIONS')?.message).toBe('Class VI at Mohali Campus has no sections.');
      expect(codes(run((i) => (i.subjectOfferings = [])))).toContain('ERROR:GRADE_WITHOUT_SUBJECTS');
      expect(codes(run((i) => i.terms.push({ id: 'T9', name: 'Late', locationId: null, startDate: '2027-04-01', endDate: '2027-05-01' })))).toContain('ERROR:TERM_OUTSIDE_SESSION');
      expect(codes(run((i) => i.groups.push({ id: 'G', gradeOfferingId: 'GO', name: 'Bad', ruleType: 'CHOOSE_N', min: 3, max: 1, status: 'ACTIVE', subjectOfferingIds: ['O1', 'O2'] })))).toEqual(
        expect.arrayContaining(['ERROR:GROUP_MIN_GREATER_THAN_MAX', 'ERROR:GROUP_MIN_EXCEEDS_ELIGIBLE']),
      );
      expect(codes(run((i) => i.programmes.push({ id: 'P', locationId: 'L1', name: 'Science', status: 'ACTIVE', subjectRules: [{ subjectOfferingId: 'GONE' }] })))).toContain('ERROR:PROGRAMME_INACTIVE_SUBJECT');
    });

    it('warnings and info never read as errors; inactive grades are ignored', () => {
      const issues = run((i) => {
        i.otherSessions.push({ id: 'o', name: 'Last year', startDate: '2026-01-01', endDate: '2026-06-30', status: 'CLOSED' });
        i.otherSessions.push({ id: 'a', name: 'Ancient', startDate: '2026-01-01', endDate: '2026-06-30', status: 'ARCHIVED' });
        i.ruleVersions.RV = { status: 'RETIRED', name: '2025-26' };
        i.terms = [];
        i.grades.G11 = { code: 'G11', sequence: 14, isBoardGrade: false };
        i.gradeOfferings.push({ id: 'G11O', locationId: 'L1', gradeId: 'G11', displayName: 'Class XI', status: 'INACTIVE' });
      });
      expect(codes(issues)).toEqual(['WARNING:RULE_VERSION_RETIRED', 'WARNING:SESSION_DATES_OVERLAP', 'WARNING:GRADE_WITHOUT_TERMS', 'INFO:NO_TERMS']);
      expect(issues.find((x) => x.code === 'SESSION_DATES_OVERLAP')?.message).toContain('Last year');

      expect(codes(run((i) => i.gradeOfferings.push({ id: 'G11O', locationId: 'L1', gradeId: 'G11', displayName: 'Class XI', status: 'ACTIVE' })))).toEqual(
        expect.arrayContaining(['ERROR:GRADE_WITHOUT_SECTIONS', 'INFO:NO_PROGRAMMES']),
      );
      // A board grade never needs terms.
      expect(codes(run((i) => { i.terms = []; i.grades.G6!.isBoardGrade = true; }))).toEqual(['INFO:NO_TERMS']);
    });

    it('lists errors first', () => {
      const issues = run((i) => { i.terms = []; i.sections = []; i.ruleVersions.RV = { status: 'RETIRED', name: 'old' }; });
      expect(issues.map((x) => x.level)).toEqual([...issues.map((x) => x.level)].sort((a, b) => ['ERROR', 'WARNING', 'INFO'].indexOf(a) - ['ERROR', 'WARNING', 'INFO'].indexOf(b)));
      expect(issues[0]!.level).toBe('ERROR');
    });
  });
});

describe('programmes and flexible combinations (AS-10, AS-11)', () => {
  /** Mohali: Grade 9, 11 and 12; Chandigarh: Grade 11. */
  async function senior() {
    const t = await draftSession();
    const more = await createMoreSubjects(t.agent);
    const [g9, g11, g12] = await addGrades(t.agent, t.id, t.moh.locationId, [t.ref.gradeId.G09!, t.ref.gradeId.G11!, t.ref.gradeId.G12!]);
    const [chd11] = await addGrades(t.agent, t.id, t.chd.locationId, [t.ref.gradeId.G11!]);
    const o9 = await offer(t.agent, g9!.gradeOfferingId, [t.subjects.ENG!]);
    const o11 = {
      ...(await offer(t.agent, g11!.gradeOfferingId, [t.subjects.ENG!])),
      ...(await offer(t.agent, g11!.gradeOfferingId, [more.PHY!, more.CHEM!, t.subjects.MATH!, more.BIO!, more.CS!], 'ELECTIVE')),
    } as Record<string, string>;
    const o12 = await offer(t.agent, g12!.gradeOfferingId, [more.PHY!]);
    const oChd = await offer(t.agent, chd11!.gradeOfferingId, [t.subjects.ENG!]);
    const create = (body: Record<string, unknown>) =>
      t.agent.post(`${API}/academic-programmes`).send({ academicSessionId: t.id, locationId: t.moh.locationId, gradeFromId: t.ref.gradeId.G11, gradeToId: t.ref.gradeId.G12, ...body });
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

  it('subjects must be offered at the programme’s location, inside its grade range, and listed once', async () => {
    const s = await senior();
    const stream = (rules: unknown[], extra: Record<string, unknown> = {}) => s.create({ name: 'S', code: 'X1', kind: 'STREAM', subjectRules: rules, ...extra });
    const rule = (id: string | undefined, requirement = 'REQUIRED') => ({ subjectOfferingId: id, requirement });

    expect(expectError(await stream([rule(s.o9.ENG)]), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty(['subjectRules.0.subjectOfferingId']); // Grade 9 is outside XI–XII
    expect(expectError(await stream([rule(s.oChd.ENG)]), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty(['subjectRules.0.subjectOfferingId']); // another location
    expect(expectError(await stream([rule(s.o11.ENG), rule(s.o11.ENG, 'OPTIONAL')]), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('subjectRules');
    expect(expectError(await stream([rule(s.o11.MATH, 'CHOICE')], { choiceMin: 1, choiceMax: 2 }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('choiceMax');
    expect(expectError(await stream([rule(s.o11.MATH, 'CHOICE'), rule(s.o11.BIO, 'CHOICE')], { choiceMin: 2, choiceMax: 1 }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('choiceMax');
    expect(expectError(await stream([rule(s.o11.ENG)], { gradeFromId: s.ref.gradeId.G12, gradeToId: s.ref.gradeId.G11 }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('gradeToId');
    expectError(await stream([rule(s.o11.ENG)], { locationId: s.pkl.locationId }), 409, 'LOCATION_NOT_IN_SESSION');
    expectError(await stream([rule(s.o11.ENG)], { boardId: '6f0b3e0a-1f2e-4d5b-8c1a-0a1b2c3d4e5f' }), 404, 'NOT_FOUND');
    expectError(await stream([rule(s.o11.ENG)], { academicSessionId: '6f0b3e0a-1f2e-4d5b-8c1a-0a1b2c3d4e5f' }), 404, 'NOT_FOUND');
    // A range that includes both grades accepts a Grade 12 subject too.
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

  it('QA 14: a flexible combination has no fixed subject list — the grade’s groups and constraints define what is allowed', async () => {
    const s = await senior();
    expect(expectError(await s.create({ name: 'Flex', code: 'FLEX', kind: 'FLEXIBLE', subjectRules: [{ subjectOfferingId: s.o11.ENG, requirement: 'REQUIRED' }] }), 400, 'VALIDATION_FAILED').details.fields).toHaveProperty('subjectRules');
    const flex = (await s.create({ name: 'Flexible Combination', code: 'FLEX', kind: 'FLEXIBLE', choiceMin: 2, choiceMax: 3 }).expect(201)).body.data as ProgrammeDTO;
    expect(flex).toMatchObject({ kind: 'FLEXIBLE', subjectRules: [], choiceMin: null, choiceMax: null });
    await s.create({ name: 'Science', code: 'SCI', kind: 'STREAM', gradeToId: s.ref.gradeId.G11, subjectRules: [{ subjectOfferingId: s.o11.PHY, requirement: 'REQUIRED' }] }).expect(201);

    // The rules a flexible student picks within live on the grade.
    const g11Url = `${API}/grade-offerings/${s.g11!.gradeOfferingId}`;
    await s.agent.post(`${g11Url}/choice-groups`).send({ name: 'Electives', ruleType: 'CHOOSE_N', min: 1, max: 3, subjectOfferingIds: [s.o11.MATH, s.o11.BIO, s.o11.CS] }).expect(201);
    await s.agent.post(`${g11Url}/constraints`).send({ type: 'EXCLUDES', subjectOfferingId: s.o11.BIO, otherSubjectOfferingId: s.o11.CS }).expect(201);

    const context = (gradeId: string) => s.agent.get(`${API}/academic-context`).query({ academicSessionId: s.id, locationId: s.moh.locationId, gradeId });
    const g11 = (await context(s.ref.gradeId.G11!).expect(200)).body.data;
    expect(g11.programmes.map((p: ProgrammeDTO) => p.code)).toEqual(['FLEX', 'SCI']);
    expect(g11.choiceGroups.map((g: ChoiceGroupDTO) => g.summary)).toEqual(['Choose 1 to 3 of Mathematics, Biology, Computer Science']);
    expect(g11.constraints.map((c: ConstraintDTO) => c.summary)).toEqual(['Biology excludes Computer Science']);
    // Grade XII is inside Flexible's range but outside Science's; Grade 9 is in neither.
    expect((await context(s.ref.gradeId.G12!).expect(200)).body.data.programmes.map((p: ProgrammeDTO) => p.code)).toEqual(['FLEX']);
    expect((await context(s.ref.gradeId.G09!).expect(200)).body.data.programmes).toEqual([]);
  });
});
