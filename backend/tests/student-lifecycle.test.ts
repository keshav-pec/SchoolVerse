import { describe, expect, it } from 'vitest';
import type {
  BulkPromotionResultDTO,
  ImportCommitResultDTO,
  ImportDTO,
  ImportIssuesDTO,
  ImportRowListDTO,
  LocationTransferResultDTO,
  LocationTransferValidationDTO,
  PromotionReadinessDTO,
  ReadmissionResultDTO,
  RepeatResultDTO,
  SignedFileLinkDTO,
  StudentAdminProfileDTO,
  StudentContextDTO,
  StudentDocumentsDTO,
  StudentHistoryDTO,
  StudentTransfersDTO,
  TransferCertificateDTO,
  WithdrawalDTO,
} from '@shared';
import { addDays } from '../src/core/dates';
import { ClassOffering } from '../src/modules/academic/offering.model';
import { AcademicSession } from '../src/modules/academic/session.model';
import { Student, StudentAdmission, StudentEnrollment, StudentGuardianLink, StudentSectionAssignment, StudentSubjectEnrollment } from '../src/modules/students/student.models';
import { StudentImportRow, StudentTransferCertificate } from '../src/modules/students/records.models';
import { processDueWithdrawals } from '../src/modules/students/jobs';
import { studentService } from '../src/modules/students/context.service';
import {
  API,
  activatedParent,
  addClasses,
  addStudent,
  createUserAndLogin,
  download,
  expectError,
  forceStatus,
  guardianLinks,
  nextPhone,
  offer,
  promotionSchool,
  serviceContextFor,
  studentBody,
  studentSchool,
  today,
  useTestDatabase,
  type Agent,
  type StudentSchool,
} from './helpers';

useTestDatabase();

const get = async <T>(agent: Agent, path: string, status = 200) => (await agent.get(`${API}${path}`).expect(status)).body.data as T;
const post = async <T>(agent: Agent, path: string, body: unknown = {}, status = 200) => {
  const res = await agent.post(`${API}${path}`).send(body as object);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
};
const profile = (agent: Agent, id: string) => get<StudentAdminProfileDTO>(agent, `/students/${id}`);

/** Students are admitted on 2 April so that moves and exits dated today fall after their enrollment began. */
const ADMITTED = { mode: 'NEW_ADMISSION', admissionDate: '2026-04-02' };

// ───────────────────────────────────────────────────────────── promotion

describe('Promotion, repeat and the last class (Module 4, Part 3 · C)', () => {
  async function scene() {
    const t = await promotionSchool();
    const nextOfferings = await ClassOffering.find({ tenantId: t.tenantId, sessionId: t.nextSessionId, locationId: t.moh.locationId }).lean();
    const nextIx = nextOfferings.find((o) => o.displayCode === '9')!;
    const ready = await addStudent(t, ADMITTED); // VIII-A
    const leaving = await addStudent(t, ADMITTED);
    const noSection = await addStudent(t, { ...ADMITTED, sectionId: undefined });
    const stuck = await addStudent(t, { ...ADMITTED, classOfferingId: t.nine.classOfferingId, sectionId: t.nine.sections.A }); // IX: no Class X next year
    const last = await addStudent(t, { ...ADMITTED, classOfferingId: t.ten.classOfferingId, sectionId: t.ten.sections.A }); // X: the last class
    await post(t.agent, `/students/${leaving.student.studentId}/withdrawal`, { leavingDate: '2027-03-31', reasonCategory: 'RELOCATION', needsTC: false }, 201);
    const scope = `fromSessionId=${t.sessionId}&toSessionId=${t.nextSessionId}&locationId=${t.moh.locationId}`;
    return { t, nextIx, ready, leaving, noSection, stuck, last, scope, body: { fromSessionId: t.sessionId, toSessionId: t.nextSessionId, locationId: t.moh.locationId } };
  }

  it('QA L1, L2, L6: readiness separates READY from NEEDS_REVIEW, suggests the standard next class, and leaves a leaving student for the exit workflow', async () => {
    const { t, nextIx, ready, leaving, noSection, stuck, last, scope } = await scene();
    const r = await get<PromotionReadinessDTO>(t.agent, `/promotions/readiness?${scope}`);
    expect(r).toMatchObject({ checked: 5, ready: 2, needsReview: 3 });
    const row = (id: string) => [...r.readyRows, ...r.reviewRows].find((x) => x.studentId === id)!;

    expect(row(ready.student.studentId)).toMatchObject({ suggestedDecision: 'PROMOTE', nextClassOfferingId: nextIx._id, isFinalClass: false, reasons: [] });
    expect(row(ready.student.studentId).suggestedSectionId).toBeTruthy();
    expect(row(last.student.studentId)).toMatchObject({ suggestedDecision: 'PASSED_OUT', isFinalClass: true, nextClassOfferingId: null, reasons: [] });
    expect(row(leaving.student.studentId).reasons.map((x) => x.code)).toEqual(['LEAVING']);
    expect(row(noSection.student.studentId).reasons.map((x) => x.code)).toContain('SECTION_MISSING');
    expect(row(stuck.student.studentId).reasons.map((x) => x.code)).toEqual(['NO_NEXT_CLASS']);
    expect(row(stuck.student.studentId).reasons[0]!.message).toBe('No class is offered for next year.');
    expect(r.reviewRows.every((x) => x.suggestedDecision === null)).toBe(true);

    // The recommendation is the same list on its own, with sections that balance the new classes.
    const recommended = await post<{ studentId: string }[]>(t.agent, '/promotions/recommend', { fromSessionId: t.sessionId, toSessionId: t.nextSessionId, locationId: t.moh.locationId });
    expect(recommended.map((x) => x.studentId).sort()).toEqual([ready.student.studentId, last.student.studentId].sort());

    // The next session must be open for new records, and the two sessions must be in order.
    await forceStatus(t.tenantId, t.nextSessionId, 'DRAFT');
    expectError(await t.agent.get(`${API}/promotions/readiness?${scope}`), 409, 'PROMOTION_TARGET_NOT_OPEN');
    await forceStatus(t.tenantId, t.nextSessionId, 'PUBLISHED');
    expectError(await t.agent.get(`${API}/promotions/readiness?fromSessionId=${t.nextSessionId}&toSessionId=${t.sessionId}&locationId=${t.moh.locationId}`), 409, 'PROMOTION_SESSIONS_INVALID');
  });

  it('QA L3, L4, L7: a bulk run creates the new enrollment, section, roll number and subjects, completes the old one without editing it, and is safe to repeat', async () => {
    const { t, nextIx, ready, leaving, stuck, last, body } = await scene();
    const before = await profile(t.agent, ready.student.studentId);
    const oldEnrollment = (await StudentEnrollment.findOne({ tenantId: t.tenantId, studentId: ready.student.studentId }).lean())!;
    const oldPlacement = (await StudentSectionAssignment.findOne({ tenantId: t.tenantId, enrollmentId: oldEnrollment._id }).lean())!;

    const run = await post<BulkPromotionResultDTO>(t.agent, '/promotions/bulk', { ...body, readyOnly: true });
    expect(run).toMatchObject({ done: 2, skipped: 0, failed: 0 });

    // The new enrollment: next class, a new section and roll number, required subjects, linked to the old one.
    const enrollments = await StudentEnrollment.find({ tenantId: t.tenantId, studentId: ready.student.studentId }).sort({ effectiveFrom: 1 }).lean();
    expect(enrollments).toHaveLength(2);
    const [old, next] = enrollments;
    expect(next).toMatchObject({ academicSessionId: t.nextSessionId, classOfferingId: nextIx._id, enrollmentType: 'PROMOTED', state: 'OPEN', previousEnrollmentId: old!._id, effectiveFrom: '2027-04-01' });
    const placement = (await StudentSectionAssignment.findOne({ tenantId: t.tenantId, enrollmentId: next!._id }).lean())!;
    expect(placement.rollNumber).toBe('1');
    expect(await StudentSubjectEnrollment.countDocuments({ tenantId: t.tenantId, enrollmentId: next!._id, source: 'AUTO_MANDATORY' })).toBe(2);

    // The old enrollment changed in exactly three ways: state, last day, outcome. Its section placement only got a last day.
    expect(old).toMatchObject({ state: 'COMPLETED', outcome: 'PROMOTED', effectiveTo: '2027-03-31' });
    for (const field of ['classOfferingId', 'academicSessionId', 'locationId', 'effectiveFrom', 'enrollmentType', 'studentId'] as const) expect(old![field], field).toEqual(oldEnrollment[field]);
    const oldAfter = (await StudentSectionAssignment.findOne({ tenantId: t.tenantId, _id: oldPlacement._id }).lean())!;
    expect(oldAfter).toMatchObject({ sectionId: oldPlacement.sectionId, rollNumber: oldPlacement.rollNumber, effectiveTo: '2027-03-31' });

    // The same student keeps the admission number and the parent; the history shows both years.
    const after = await profile(t.agent, ready.student.studentId);
    expect(after.admissionNumber).toBe(before.admissionNumber);
    expect(after.guardianCount).toBe(1);
    const history = await get<StudentHistoryDTO>(t.agent, `/students/${ready.student.studentId}/history`);
    expect(history.entries.filter((e) => e.kind === 'ENROLLMENT').map((e) => e.title).join(' | ')).toMatch(/Promoted to .*9.*2027-28/);

    // The last class finishes school: the old enrollment is completed (PASSED_OUT), no new one is made.
    expect((await profile(t.agent, last.student.studentId)).status).toBe('COMPLETED_SCHOOLING');
    expect(await StudentEnrollment.find({ tenantId: t.tenantId, studentId: last.student.studentId }).lean()).toMatchObject([{ state: 'COMPLETED', outcome: 'PASSED_OUT' }]);

    // Students who needed a look were not touched.
    for (const id of [leaving.student.studentId, stuck.student.studentId]) expect(await StudentEnrollment.countDocuments({ tenantId: t.tenantId, studentId: id, academicSessionId: t.nextSessionId })).toBe(0);
    expect((await profile(t.agent, leaving.student.studentId)).status).toBe('WITHDRAWAL_INITIATED');

    // Running it again changes nothing; asking for the same students again says "already promoted".
    expect(await post<BulkPromotionResultDTO>(t.agent, '/promotions/bulk', { ...body, readyOnly: true })).toMatchObject({ done: 0, failed: 0 });
    const again = await post<BulkPromotionResultDTO>(t.agent, '/promotions/bulk', { ...body, decisions: [{ studentId: ready.student.studentId, decision: 'PROMOTE' }, { studentId: last.student.studentId, decision: 'PASSED_OUT' }] });
    expect(again.rows.map((r) => [r.status, r.message])).toEqual([['SKIPPED', 'Already promoted.'], ['SKIPPED', 'Already promoted.']]);
    expect(await StudentEnrollment.countDocuments({ tenantId: t.tenantId, studentId: ready.student.studentId })).toBe(2);
  });

  it('QA L5, L6: a student can repeat the class; decisions can hold, leave or finish; one failure does not stop the others', async () => {
    const { t, noSection, ready, stuck, body } = await scene();
    const repeated = await post<RepeatResultDTO>(t.agent, `/students/${ready.student.studentId}/repeat`, { toSessionId: t.nextSessionId });
    const [old, next] = (await StudentEnrollment.find({ tenantId: t.tenantId, studentId: ready.student.studentId }).sort({ effectiveFrom: 1 }).lean())!;
    expect(old).toMatchObject({ _id: repeated.fromEnrollmentId, state: 'COMPLETED', outcome: 'REPEATED' });
    expect(next).toMatchObject({ _id: repeated.toEnrollmentId, enrollmentType: 'REPEATING', classOfferingId: expect.not.stringMatching(old!.classOfferingId) });
    expect((await ClassOffering.findOne({ tenantId: t.tenantId, _id: next!.classOfferingId }).lean())!.classId).toBe((await ClassOffering.findOne({ tenantId: t.tenantId, _id: old!.classOfferingId }).lean())!.classId);

    const run = await post<BulkPromotionResultDTO>(t.agent, '/promotions/bulk', {
      ...body,
      decisions: [
        { studentId: noSection.student.studentId, decision: 'HOLD' },
        { studentId: stuck.student.studentId, decision: 'PASSED_OUT' }, // not in the last class: refused, in plain words
        { studentId: noSection.student.studentId, decision: 'LEAVING' },
        { studentId: stuck.student.studentId, decision: 'PROMOTE' }, // no class next year: fails, the run goes on
      ],
    });
    expect(run).toMatchObject({ done: 0, skipped: 2, failed: 2 });
    expect(run.rows.find((r) => r.decision === 'PASSED_OUT')!.message).toMatch(/not in the last class/);
    expect(run.rows.find((r) => r.decision === 'PROMOTE')!.message).toMatch(/No class is offered/);
    expect(await StudentEnrollment.countDocuments({ tenantId: t.tenantId, studentId: noSection.student.studentId, academicSessionId: t.nextSessionId })).toBe(0);
  });

  it('a plain promotion adds the required subjects of the new class and needs no choice', async () => {
    const t = await promotionSchool();
    const kid = await addStudent(t, ADMITTED);
    const run = await post<BulkPromotionResultDTO>(t.agent, '/promotions/bulk', { fromSessionId: t.sessionId, toSessionId: t.nextSessionId, locationId: t.moh.locationId, readyOnly: true });
    expect(run.rows.find((r) => r.studentId === kid.student.studentId)).toMatchObject({ status: 'DONE', message: null });
  });
});

// ───────────────────────────────────────────────────────────── campus transfer

describe('Moving to another campus (Module 4, Part 3 · C)', () => {
  /** Class VIII at Chandigarh with a section and the same two subjects. */
  async function withChandigarh(t: StudentSchool, sameBoard: boolean) {
    const [offering] = await addClasses(t.agent, t.sessionId, t.chd.locationId, [t.ref.classId.G08!]);
    const section = (await t.agent.post(`${API}/class-offerings/${offering!.classOfferingId}/sections`).send({ codes: ['A'] }).expect(201)).body.data[0] as { sectionOfferingId: string };
    const subjects = Object.fromEntries((await t.agent.get(`${API}/subjects?pageSize=100`).expect(200)).body.data.items.map((s: { subjectCode: string; subjectId: string }) => [s.subjectCode, s.subjectId])) as Record<string, string>;
    await offer(t.agent, offering!.classOfferingId, [subjects.MATH!, subjects.SCI!]);
    if (sameBoard) {
      const session = (await AcademicSession.findOne({ _id: t.sessionId, tenantId: t.tenantId }).lean())!;
      const moh = session.locations.find((l) => l.locationId === t.moh.locationId)!;
      await AcademicSession.updateOne({ _id: t.sessionId, tenantId: t.tenantId }, { $set: { locations: session.locations.map((l) => (l.locationId === t.chd.locationId ? { ...l, boardId: moh.boardId, boardRuleVersionId: moh.boardRuleVersionId } : l)) } });
    }
    return { classOfferingId: offering!.classOfferingId, sectionId: section.sectionOfferingId };
  }

  it('QA L8: a move to Chandigarh keeps the same student, admission number and guardians, and both campuses show in History', async () => {
    const t = await studentSchool();
    const dest = await withChandigarh(t, true);
    const kid = await addStudent(t, ADMITTED);
    const body = { toLocationId: t.chd.locationId, classOfferingId: dest.classOfferingId, sectionId: dest.sectionId, effectiveDate: today() };

    const check = await post<LocationTransferValidationDTO>(t.agent, `/students/${kid.student.studentId}/location-transfer/validate`, body);
    expect(check).toMatchObject({ canTransfer: true, boardChanged: false, subjectMappingRequired: false, problems: [] });
    expect(check.from.locationName).toBe('Mohali Campus');
    expect(check.to).toMatchObject({ locationName: 'Chandigarh Campus', sectionLabel: expect.stringContaining('-A') });

    const result = await post<LocationTransferResultDTO>(t.agent, `/students/${kid.student.studentId}/location-transfer`, { ...body, reason: 'Family moved to Chandigarh' });
    expect(result).toMatchObject({ mandatorySubjectsAdded: 2, choicePending: false });
    expect(result.event).toMatchObject({ type: 'LOCATION', fromLocationId: t.moh.locationId, toLocationId: t.chd.locationId });

    const rows = await StudentEnrollment.find({ tenantId: t.tenantId, studentId: kid.student.studentId }).sort({ effectiveFrom: 1 }).lean();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: 'TRANSFERRED', locationId: t.moh.locationId, effectiveTo: addDays(today(), -1) });
    expect(rows[1]).toMatchObject({ state: 'OPEN', locationId: t.chd.locationId, enrollmentType: 'MID_SESSION_TRANSFER', previousEnrollmentId: rows[0]!._id, effectiveFrom: today() });

    const after = await profile(t.agent, kid.student.studentId);
    expect(after).toMatchObject({ studentId: kid.student.studentId, admissionNumber: kid.student.admissionNumber, guardianCount: 1, locationId: t.chd.locationId, status: 'ACTIVE' });
    expect(await StudentAdmission.countDocuments({ tenantId: t.tenantId, studentId: kid.student.studentId })).toBe(1);
    const history = await get<StudentHistoryDTO>(t.agent, `/students/${kid.student.studentId}/history`);
    expect(history.entries.map((e) => e.title).join(' | ')).toMatch(/Moved from Mohali Campus to Chandigarh Campus/);
    expect((await get<StudentTransfersDTO>(t.agent, `/students/${kid.student.studentId}/transfers`)).items).toHaveLength(1);
    // Same campus again is not a move.
    const again = await t.agent.post(`${API}/students/${kid.student.studentId}/location-transfer`).send({ ...body, toLocationId: t.chd.locationId, reason: 'again', effectiveDate: addDays(today(), 1) });
    expectError(again, 409, 'TRANSFER_NOT_POSSIBLE');
  });

  it('QA L9: a move to a campus on a different board needs the subjects chosen again', async () => {
    const t = await studentSchool(); // Mohali follows CBSE, Chandigarh follows PSEB
    const dest = await withChandigarh(t, false);
    const kid = await addStudent(t, ADMITTED);
    const move = { toLocationId: t.chd.locationId, classOfferingId: dest.classOfferingId, sectionId: dest.sectionId, effectiveDate: today() };
    const body = { ...move, reason: 'Moved' };
    const check = await post<LocationTransferValidationDTO>(t.agent, `/students/${kid.student.studentId}/location-transfer/validate`, move);
    expect(check).toMatchObject({ canTransfer: true, boardChanged: true, subjectMappingRequired: true });
    expect(check.warnings.join(' ')).toMatch(/different board/);
    expect(check.destinationSubjects.map((s) => s.subjectName).sort()).toEqual(['Mathematics', 'Science']);

    const refused = expectError(await t.agent.post(`${API}/students/${kid.student.studentId}/location-transfer`).send(body), 409, 'SUBJECT_MAPPING_REQUIRED');
    expect((refused.details as unknown as { destinationSubjects: unknown[] }).destinationSubjects).toHaveLength(2);
    expect(await StudentEnrollment.countDocuments({ tenantId: t.tenantId, studentId: kid.student.studentId })).toBe(1);

    const done = await post<LocationTransferResultDTO>(t.agent, `/students/${kid.student.studentId}/location-transfer`, { ...body, subjectOfferingIds: [] });
    expect(done.mandatorySubjectsAdded).toBe(2);
    expect((await profile(t.agent, kid.student.studentId)).admissionNumber).toBe(kid.student.admissionNumber);
  });
});

// ───────────────────────────────────────────────────────────── withdrawal, certificate, readmission

describe('Exit, Transfer Certificate and readmission (Module 4, Part 3 · D)', () => {
  it('QA L10: completing a withdrawal closes the enrollment, section and subjects, ends parent access, and makes the record read-only', async () => {
    const t = await studentSchool();
    const kid = await addStudent(t, { ...ADMITTED, guardian: { legalFirstName: 'Mina', legalLastName: 'Ghosh', phone: nextPhone(), email: 'mina.ghosh.p3@greenfield.demo', relationshipType: 'Mother' } });
    const parent = await activatedParent(t, kid.student.studentId, 'mina.ghosh.p3@greenfield.demo');
    const id = kid.student.studentId;

    const started = await post<WithdrawalDTO>(t.agent, `/students/${id}/withdrawal`, { leavingDate: today(), reasonCategory: 'RELOCATION', destinationSchool: 'Delhi Public School', needsTC: true }, 201);
    expect(started).toMatchObject({ status: 'WITHDRAWAL_INITIATED', due: true });
    expect(started.checklist.map((c) => [c.key, c.done])).toEqual([['LEAVING_DATE', true], ['TC', false], ['DUES', false], ['PORTAL', false]]);
    expectError(await t.agent.post(`${API}/students/${id}/withdrawal`).send({ leavingDate: today(), reasonCategory: 'OTHER', needsTC: false }), 409, 'WITHDRAWAL_ALREADY_STARTED');
    // The parent still has access until the student has left.
    await parent.agent.get(`${API}/parent/children/${id}`).expect(200);

    const done = await post<WithdrawalDTO>(t.agent, `/students/${id}/withdrawal/complete`);
    expect(done.status).toBe('TRANSFERRED_OUT'); // another school: the student is transferred out
    const enrollment = (await StudentEnrollment.findOne({ tenantId: t.tenantId, studentId: id }).lean())!;
    expect(enrollment).toMatchObject({ state: 'TRANSFERRED', effectiveTo: today() });
    expect(await StudentSectionAssignment.findOne({ tenantId: t.tenantId, studentId: id }).lean()).toMatchObject({ effectiveTo: today() });
    expect(await StudentSubjectEnrollment.countDocuments({ tenantId: t.tenantId, studentId: id, effectiveTo: null })).toBe(0);
    // Parent access ended with the exit; the login and the link stay.
    expectError(await parent.agent.get(`${API}/parent/children/${id}`), 404, 'NOT_FOUND');
    expect(await StudentGuardianLink.countDocuments({ tenantId: t.tenantId, studentId: id, portalEnabled: false, portalRevokedAt: { $ne: null } })).toBe(1);
    // The record is history: nothing can change.
    const after = await profile(t.agent, id);
    expectError(await t.agent.patch(`${API}/students/${id}`).send({ version: after.version, notes: 'x' }), 409, 'STUDENT_READ_ONLY');
    expectError(await t.agent.post(`${API}/students/${id}/withdrawal/complete`), 409, 'WITHDRAWAL_NOT_STARTED');
    await expect(studentService.assertStudentUsable(t.ctx, id, 'NEW_RECORD')).rejects.toMatchObject({ code: 'STUDENT_READ_ONLY' });
    await expect(studentService.assertStudentUsable(t.ctx, id, 'HISTORICAL_READ')).resolves.toBe('TRANSFERRED_OUT');
  });

  it('a withdrawal with a future leaving date keeps the student active until then, and can be cancelled', async () => {
    const t = await studentSchool();
    const kid = await addStudent(t, ADMITTED);
    const id = kid.student.studentId;
    await post(t.agent, `/students/${id}/withdrawal`, { leavingDate: addDays(today(), 10), reasonCategory: 'HEALTH', needsTC: false }, 201);
    expectError(await t.agent.post(`${API}/students/${id}/withdrawal/complete`), 409, 'WITHDRAWAL_NOT_DUE');
    expect(await StudentEnrollment.findOne({ tenantId: t.tenantId, studentId: id }).lean()).toMatchObject({ state: 'OPEN', effectiveTo: null });
    const changed = await t.agent.patch(`${API}/students/${id}/withdrawal`).send({ note: 'Back in April' }).expect(200);
    expect(changed.body.data.note).toBe('Back in April');
    expect(await post<{ status: string }>(t.agent, `/students/${id}/withdrawal/cancel`)).toMatchObject({ status: 'ACTIVE' });
    expect((await StudentEnrollment.findOne({ tenantId: t.tenantId, studentId: id }).lean())!.state).toBe('OPEN');
    expectError(await t.agent.get(`${API}/students/${id}/withdrawal`), 409, 'WITHDRAWAL_NOT_STARTED');
    // Only an active student can start a withdrawal.
    const draft = (await t.agent.post(`${API}/students`).send({ draft: true, legalFirstName: 'Draft', legalLastName: 'Kid' }).expect(201)).body.data.student;
    expectError(await t.agent.post(`${API}/students/${draft.studentId}/withdrawal`).send({ leavingDate: today(), reasonCategory: 'OTHER', needsTC: false }), 409, 'INVALID_STATUS_TRANSITION');
  });

  it('QA L14: processDueWithdrawals completes a future leaving date on the day, and only once', async () => {
    const t = await studentSchool();
    const due = await addStudent(t, ADMITTED);
    const later = await addStudent(t, ADMITTED);
    await post(t.agent, `/students/${due.student.studentId}/withdrawal`, { leavingDate: addDays(today(), 2), reasonCategory: 'FAMILY_REASONS', needsTC: false }, 201);
    await post(t.agent, `/students/${later.student.studentId}/withdrawal`, { leavingDate: addDays(today(), 20), reasonCategory: 'FAMILY_REASONS', needsTC: false }, 201);
    expect(await processDueWithdrawals(new Date())).toBe(0);
    expect(await processDueWithdrawals(new Date(Date.now() + 3 * 86_400_000))).toBe(1);
    expect((await profile(t.agent, due.student.studentId)).status).toBe('WITHDRAWN');
    expect((await profile(t.agent, later.student.studentId)).status).toBe('WITHDRAWAL_INITIATED');
    expect(await processDueWithdrawals(new Date(Date.now() + 3 * 86_400_000))).toBe(0);
    // The scheduled run is recorded as the system, not as a person.
    const history = await get<StudentHistoryDTO>(t.agent, `/students/${due.student.studentId}/history`);
    expect(history.entries.find((e) => e.title === 'Student left the school')!.actorName).toBeNull();
  });

  it('QA L11, L12: a Transfer Certificate goes Requested → Pending clearance → Approved → Issued, then it is locked; a duplicate is marked and audited', async () => {
    const t = await studentSchool();
    const kid = await addStudent(t, ADMITTED);
    const id = kid.student.studentId;
    const tc = await post<TransferCertificateDTO>(t.agent, `/students/${id}/transfer-certificates`, { reasonForLeaving: 'Moving to another city', result: 'Passed' }, 201);
    expect(tc).toMatchObject({ status: 'REQUESTED', certificateNumber: null, lastClass: expect.any(String), duesStatus: 'PENDING', locked: false });
    expectError(await t.agent.post(`${API}/students/${id}/transfer-certificates`).send({}), 409, 'TC_ALREADY_OPEN');
    expectError(await t.agent.post(`${API}/transfer-certificates/${tc.certificateId}/issue`).send({}), 409, 'TC_NOT_READY');

    // Dues are pending, so approving parks it; once dues are cleared, approving works.
    expect((await post<TransferCertificateDTO>(t.agent, `/transfer-certificates/${tc.certificateId}/approve`)).status).toBe('PENDING_CLEARANCE');
    const edited = await t.agent.patch(`${API}/transfer-certificates/${tc.certificateId}`).send({ duesStatus: 'CLEARED', reasonForLeaving: 'Family relocation' }).expect(200);
    expect(edited.body.data).toMatchObject({ duesStatus: 'CLEARED', reasonForLeaving: 'Family relocation', status: 'PENDING_CLEARANCE' });
    expect((await post<TransferCertificateDTO>(t.agent, `/transfer-certificates/${tc.certificateId}/approve`)).status).toBe('APPROVED');

    const issued = await post<TransferCertificateDTO>(t.agent, `/transfer-certificates/${tc.certificateId}/issue`, {});
    expect(issued).toMatchObject({ status: 'ISSUED', certificateNumber: 'TC/2026-27/0001', locked: true, issueDate: today(), copyType: 'ORIGINAL' });
    expect(issued.documentId).toBeTruthy();
    // The PDF is a private document the school made, and it does not count as the old school's TC.
    const docs = await get<StudentDocumentsDTO>(t.agent, `/students/${id}/documents`);
    expect(docs.items.find((d) => d.documentId === issued.documentId)).toMatchObject({ issuedBySchool: true, documentType: 'TRANSFER_CERTIFICATE' });
    const link = await post<SignedFileLinkDTO>(t.agent, `/student-documents/${issued.documentId}/download`);
    expect((await download(link.url)).body.subarray(0, 5).toString()).toBe('%PDF-');
    expectError(await t.agent.delete(`${API}/student-documents/${issued.documentId}`), 409, 'TC_ISSUED_LOCKED');

    // Locked: nothing edits an issued certificate.
    expectError(await t.agent.patch(`${API}/transfer-certificates/${tc.certificateId}`).send({ reasonForLeaving: 'Changed' }), 409, 'TC_ISSUED_LOCKED');
    expectError(await t.agent.post(`${API}/transfer-certificates/${tc.certificateId}/approve`), 409, 'TC_ISSUED_LOCKED');
    expectError(await t.agent.post(`${API}/transfer-certificates/${tc.certificateId}/cancel`), 409, 'TC_ISSUED_LOCKED');
    expectError(await t.agent.post(`${API}/transfer-certificates/${tc.certificateId}/issue`).send({}), 409, 'TC_ISSUED_LOCKED');
    expect((await StudentTransferCertificate.findOne({ tenantId: t.tenantId, _id: tc.certificateId }).lean())!.reasonForLeaving).toBe('Family relocation');
    expectError(await t.agent.post(`${API}/students/${id}/transfer-certificates`).send({}), 409, 'TC_ALREADY_OPEN');

    // A duplicate needs a reason, gets its own number, and leaves the original alone.
    await t.agent.post(`${API}/transfer-certificates/${tc.certificateId}/duplicate`).send({}).expect(400);
    const duplicate = await post<TransferCertificateDTO>(t.agent, `/transfer-certificates/${tc.certificateId}/duplicate`, { reason: 'Original lost' }, 201);
    expect(duplicate).toMatchObject({ status: 'DUPLICATE_ISSUED', copyType: 'DUPLICATE', certificateNumber: 'TC/2026-27/0002', duplicateReason: 'Original lost', originalCertificateId: tc.certificateId, locked: true });
    const all = await get<TransferCertificateDTO[]>(t.agent, `/students/${id}/transfer-certificates`);
    expect(all.map((c) => c.certificateNumber).sort()).toEqual(['TC/2026-27/0001', 'TC/2026-27/0002']);
    expect(all.find((c) => c.certificateId === tc.certificateId)!.status).toBe('ISSUED');
    const audit = await get<{ items: { action: string }[] }>(t.agent, `/audit?entityType=transfer_certificate&limit=50`);
    expect(audit.items.map((a) => a.action)).toEqual(expect.arrayContaining(['transfer_certificate.requested', 'transfer_certificate.pending_clearance', 'transfer_certificate.approved', 'transfer_certificate.issued', 'transfer_certificate.duplicate_issued']));
    // A certificate that was never issued can have no duplicate.
    const other = await addStudent(t, ADMITTED);
    const open = await post<TransferCertificateDTO>(t.agent, `/students/${other.student.studentId}/transfer-certificates`, {}, 201);
    expectError(await t.agent.post(`${API}/transfer-certificates/${open.certificateId}/duplicate`).send({ reason: 'x' }), 409, 'TC_NOT_READY');
    // A second school's numbers do not collide with ours (numbers are per school).
    const cancelled = await post<TransferCertificateDTO>(t.agent, `/transfer-certificates/${open.certificateId}/cancel`);
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('QA L13: readmission reuses the same student and history; the number follows the policy; parents must be confirmed', async () => {
    const t = await studentSchool();
    const kid = await addStudent(t, ADMITTED);
    const id = kid.student.studentId;
    const body = { academicSessionId: t.sessionId, locationId: t.moh.locationId, classOfferingId: t.classOfferingId, sectionId: t.sections.B };
    expectError(await t.agent.post(`${API}/students/${id}/readmit`).send(body), 409, 'STUDENT_NOT_EXITED');

    await post(t.agent, `/students/${id}/withdrawal`, { leavingDate: today(), reasonCategory: 'FAMILY_REASONS', needsTC: false }, 201);
    await post(t.agent, `/students/${id}/withdrawal/complete`);
    const keep = await post<ReadmissionResultDTO>(t.agent, `/students/${id}/readmit`, { ...body, admissionNumberPolicy: 'KEEP_OLD' });
    expect(keep).toMatchObject({ admissionNumber: kid.student.admissionNumber, admissionNumberPolicy: 'KEEP_OLD' });
    expect(keep.student).toMatchObject({ studentId: id, status: 'ACTIVE', personId: kid.student.personId });
    expect(keep.guardiansToConfirm).toHaveLength(1);
    expect(keep.guardiansToConfirm[0]!.portalEnabled).toBe(false);
    expect(await Student.countDocuments({ tenantId: t.tenantId, personId: kid.student.personId })).toBe(1);
    expect((await StudentAdmission.find({ tenantId: t.tenantId, studentId: id }).sort({ createdAt: 1 }).lean()).map((a) => [a.mode, a.admissionNumber, a.isCurrent])).toEqual([
      ['NEW_ADMISSION', kid.student.admissionNumber, false],
      ['READMISSION', kid.student.admissionNumber, true],
    ]);
    const enrollments = await StudentEnrollment.find({ tenantId: t.tenantId, studentId: id }).sort({ effectiveFrom: 1 }).lean();
    expect(enrollments.map((e) => e.enrollmentType)).toEqual(['NEW_ADMISSION', 'READMISSION']);
    expect(enrollments[1]!.previousEnrollmentId).toBe(enrollments[0]!._id);
    const history = await get<StudentHistoryDTO>(t.agent, `/students/${id}/history`);
    expect(history.entries.map((e) => e.title).join(' | ')).toMatch(/Readmitted to.*Admitted to|Admitted to.*Readmitted to/);

    // Leave again and come back with a new number.
    await post(t.agent, `/students/${id}/withdrawal`, { leavingDate: today(), reasonCategory: 'FAMILY_REASONS', needsTC: false }, 201);
    await post(t.agent, `/students/${id}/withdrawal/complete`);
    const fresh = await post<ReadmissionResultDTO>(t.agent, `/students/${id}/readmit`, { ...body, sectionId: t.sections.C, admissionNumberPolicy: 'ISSUE_NEW' });
    expect(fresh.admissionNumber).not.toBe(kid.student.admissionNumber);
    expect(fresh.admissionNumber).toMatch(/^GPS\/2026\/\d{5}$/);
    expect(await StudentAdmission.countDocuments({ tenantId: t.tenantId, studentId: id })).toBe(3);
    // Another student cannot take a retired number.
    expectError(await t.agent.post(`${API}/students`).send(studentBody(t, { mode: 'MIGRATION', admissionDate: '2020-04-01', admissionNumber: kid.student.admissionNumber })), 409, 'ADMISSION_NUMBER_TAKEN');
  });
});

// ───────────────────────────────────────────────────────────── import

describe('Importing existing students (Module 4, Part 3 · E)', () => {
  const HEADER = 'Student Name,DOB,Admission No,Admission Date,Class,Section,Roll No,Father Name,Father Mobile,Father Email,Subjects';
  const csvOf = (...rows: string[]) => [HEADER, ...rows].join('\n');

  async function importScene() {
    const t = await studentSchool();
    // A second class with a section "D", and a student and parent who are already in the school.
    const [nine] = await addClasses(t.agent, t.sessionId, t.moh.locationId, [t.ref.classId.G09!]);
    await t.agent.post(`${API}/class-offerings/${nine!.classOfferingId}/sections`).send({ codes: ['D'] }).expect(201);
    const existing = await addStudent(t, { mode: 'MIGRATION', admissionDate: '2019-04-01', admissionNumber: 'GPS/2019/00099', guardian: { legalFirstName: 'Meena', legalLastName: 'Roy', phone: '+91 98140 55555', email: 'meena.roy.p3@greenfield.demo', relationshipType: 'Mother' } });
    return { t, existing };
  }
  const upload = (t: { agent: Agent; moh: { locationId: string } }, content: string | Buffer, mode = 'EXISTING_STUDENTS', name = 'students.csv') =>
    t.agent.post(`${API}/students/imports`).field('mode', mode).field('locationId', t.moh.locationId).attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), { filename: name, contentType: 'text/csv' });

  it('QA M1–M9: matches the columns, groups the problems, imports only the ready rows, and a retry never duplicates anyone', async () => {
    const { t, existing } = await importScene();
    const rows = [
      /* 2 */ 'Aanya Roy,2012-02-01,GPS/2020/00201,2020-04-01,VIII,A,1,Ravi Roy,+91 98140 20001,ravi.roy.p3@greenfield.demo,',
      /* 3 */ 'Bhavya Sen,2012-03-02,GPS/2020/00202,2020-04-01,Class 8,B,1,Amit Sen,+91 98140 20002,amit.sen.p3@greenfield.demo,',
      /* 4 */ 'Chirag Das,2012-04-03,GPS/2020/00201,2020-04-01,VIII,A,2,Nitin Das,+91 98140 20003,nitin.das.p3@greenfield.demo,',
      /* 5 */ `Dev Rao,2012-05-04,${existing.student.admissionNumber},2019-04-01,VIII,A,3,Sunil Rao,+91 98140 20004,sunil.rao.p3@greenfield.demo,`,
      /* 6 */ 'Esha Nair,2012-06-05,GPS/2020/00205,2020-04-01,VIII,D,4,Vijay Nair,+91 98140 20005,vijay.nair.p3@greenfield.demo,',
      /* 7 */ 'Farhan Ali,2012-07-06,GPS/2020/00206,2020-04-01,VIII,A,1,Imran Ali,+91 98140 20006,imran.ali.p3@greenfield.demo,',
      /* 8 */ 'Gauri Menon,2012-08-07,GPS/2020/00207,2020-04-01,VIII,B,2,Deepak Menon,+91 98140 20007,deepak.menon.p3@greenfield.demo,Underwater Basket Weaving',
      /* 9 */ 'Hari Om,2012-09-08,GPS/2020/00208,2020-04-01,XII,A,5,Om Prakash,+91 98140 20008,om.prakash.p3@greenfield.demo,',
      /* 10 */ 'Isha Gupta,2012-13-45,GPS/2020/00209,2020-04-01,VIII,C,6,Ravi Gupta,+91 98140 20009,ravi.gupta.p3@greenfield.demo,',
      /* 11 */ 'Jai Roy,2013-01-09,GPS/2020/00210,2020-04-01,VIII,C,7,Meena Roy,+91 98140 55555,meena.roy.p3@greenfield.demo,',
      /* 12 */ 'Kiran Bose,2013-02-10,GPS/2020/00211,2020-04-01,VIII,C,8,Anil Bose,+91 98140 20011,anil.bose.p3@greenfield.demo,',
    ];
    const created = (await upload(t, csvOf(...rows)).expect(201)).body.data as ImportDTO;
    // M1: every column was matched from its heading.
    expect(created).toMatchObject({ status: 'MAPPED', mode: 'EXISTING_STUDENTS', missingRequired: [] });
    expect(created.mapping).toMatchObject({ studentName: 'Student Name', dateOfBirth: 'DOB', admissionNumber: 'Admission No', className: 'Class', sectionName: 'Section', rollNumber: 'Roll No', guardianName: 'Father Name', guardianPhone: 'Father Mobile', guardianEmail: 'Father Email', subjects: 'Subjects' });
    expect(created.summary.total).toBe(rows.length);

    const checked = await post<ImportDTO>(t.agent, `/students/imports/${created.importId}/validate`);
    // Ready: rows 2, 3, 11 (parent already here) and 12. The rest need attention.
    expect(checked.summary).toMatchObject({ total: 11, ready: 4, needsAttention: 7 });
    expect(checked.summary.message).toBe('11 rows: 4 ready, 7 need attention');

    // M7: the problems are grouped by kind, each with a suggested fix.
    const issues = await get<ImportIssuesDTO>(t.agent, `/students/imports/${created.importId}/issues`);
    const group = (code: string) => issues.groups.find((g) => g.code === code);
    expect(group('DUPLICATE_ADMISSION_NUMBER_IN_FILE')).toMatchObject({ count: 1, rowNumbers: [4] }); // M2 (in the file)
    expect(group('ADMISSION_NUMBER_TAKEN')).toMatchObject({ count: 1, rowNumbers: [5] }); // M2 (in the school)
    expect(group('SECTION_CLASS_MISMATCH')).toMatchObject({ rowNumbers: [6] }); // M3: section D belongs to Class IX, not VIII
    expect(group('ROLL_NUMBER_CLASH')).toMatchObject({ rowNumbers: [7] }); // M5: row 7 takes roll 1 in VIII-A, which row 2 already has
    expect(group('INVALID_SUBJECT_CHOICE')).toMatchObject({ rowNumbers: [8] }); // M6
    expect(group('CLASS_NOT_OFFERED')).toMatchObject({ rowNumbers: [9] });
    expect(group('INVALID_DATE')).toMatchObject({ rowNumbers: [10] });
    expect(group('PARENT_FOUND')).toMatchObject({ level: 'INFO', rowNumbers: [11] }); // M4: the parent is reused
    expect(group('PARENT_FOUND')!.suggestedFix).toMatch(/existing parent/);
    expect(issues.groups.every((g) => g.suggestedFix.length > 0)).toBe(true);

    // M9: the error report is a CSV with row, field, problem and fix, and no student names.
    const report = await t.agent.get(`${API}/students/imports/${created.importId}/issues.csv`).expect(200);
    expect(report.headers['content-type']).toMatch(/text\/csv/);
    expect(report.text).toContain('Row,Field,Problem,Suggested fix');
    expect(report.text).not.toMatch(/Bhavya|Chirag|Esha|Farhan|Gauri|Isha Gupta/);
    expect(report.text).not.toContain('PARENT_FOUND');

    // Only the problem rows are listed by default.
    const list = await get<ImportRowListDTO>(t.agent, `/students/imports/${created.importId}/rows`);
    expect(list.total).toBe(7);
    expect(list.items.every((r) => r.status === 'NEEDS_ATTENTION')).toBe(true);

    // M8: only READY rows are imported, each one a complete student.
    const before = await Student.countDocuments({ tenantId: t.tenantId });
    const committed = await post<ImportCommitResultDTO>(t.agent, `/students/imports/${created.importId}/commit`);
    expect(committed).toMatchObject({ imported: 4, failed: 0 });
    expect(await Student.countDocuments({ tenantId: t.tenantId })).toBe(before + 4);
    const aanya = (await get<{ items: { studentId: string; fullName: string }[] }>(t.agent, '/students?q=Aanya')).items[0]!;
    const profileA = await profile(t.agent, aanya.studentId);
    expect(profileA).toMatchObject({ admissionNumber: 'GPS/2020/00201', rollNumber: '1', guardianCount: 1, dateOfBirth: '2012-02-01' });
    expect(profileA.classSection?.label).toBe('8-A');
    expect(await StudentAdmission.findOne({ tenantId: t.tenantId, admissionNumber: 'GPS/2020/00201' }).lean()).toMatchObject({ mode: 'MIGRATION', admissionDate: '2020-04-01' });
    // The parent who was already here was reused, not copied.
    const jai = (await get<{ items: { studentId: string }[] }>(t.agent, '/students?q=Jai')).items[0]!;
    expect((await guardianLinks(t.agent, jai.studentId))[0]!.guardianPersonId).toBe((await guardianLinks(t.agent, existing.student.studentId))[0]!.guardianPersonId);
    expect(await StudentImportRow.countDocuments({ tenantId: t.tenantId, importId: created.importId, status: 'IMPORTED' })).toBe(4);

    // A retry creates nobody twice.
    expect(await post<ImportCommitResultDTO>(t.agent, `/students/imports/${created.importId}/commit`)).toMatchObject({ imported: 0 });
    // The same file uploaded again: every row is now flagged, so nothing new can be imported.
    const second = (await upload(t, csvOf(...rows)).expect(201)).body.data as ImportDTO;
    await post(t.agent, `/students/imports/${second.importId}/validate`);
    expect((await post<ImportCommitResultDTO>(t.agent, `/students/imports/${second.importId}/commit`)).imported).toBe(0);
    expect(await Student.countDocuments({ tenantId: t.tenantId })).toBe(before + 4);

    // A problem row can be fixed in the app and checked again.
    const clash = list.items.find((r) => r.rowNumber === 7)!;
    await t.agent.patch(`${API}/students/imports/${created.importId}/rows/${clash.rowId}`).send({ values: { rollNumber: '9' } }).expect(200);
    const rechecked = await post<ImportDTO>(t.agent, `/students/imports/${created.importId}/validate`);
    expect(rechecked.summary.ready).toBe(1);
    expect(await post<ImportCommitResultDTO>(t.agent, `/students/imports/${created.importId}/commit`)).toMatchObject({ imported: 1 });
    expect((await get<{ items: { rollNumber: string }[] }>(t.agent, '/students?q=Farhan')).items[0]!.rollNumber).toBe('9');
  }, 60_000);

  it('columns that are not recognised are matched by hand; the file is checked first; and the file itself is checked', async () => {
    const { t } = await importScene();
    const odd = (await upload(t, 'Who,Where\nAanya Roy,VIII\n').expect(201)).body.data as ImportDTO;
    expect(odd).toMatchObject({ status: 'UPLOADED', missingRequired: ['studentName', 'className'] });
    expectError(await t.agent.post(`${API}/students/imports/${odd.importId}/validate`), 422, 'IMPORT_MAPPING_INCOMPLETE');
    expectError(await t.agent.post(`${API}/students/imports/${odd.importId}/commit`), 409, 'IMPORT_NOT_READY');
    await t.agent.post(`${API}/students/imports/${odd.importId}/map`).send({ mapping: { studentName: 'Nope' } }).expect(400);
    const mapped = await post<ImportDTO>(t.agent, `/students/imports/${odd.importId}/map`, { mapping: { studentName: 'Who', className: 'Where' } });
    expect(mapped).toMatchObject({ status: 'MAPPED', missingRequired: [] });
    const checked = await post<ImportDTO>(t.agent, `/students/imports/${odd.importId}/validate`);
    expect(checked.summary).toMatchObject({ total: 1, ready: 0, needsAttention: 1 }); // no parent, no admission number

    expectError(await upload(t, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0, 1, 2, 3])]), 'EXISTING_STUDENTS', 'a.csv'), 422, 'IMPORT_FILE_INVALID');
    expectError(await upload(t, 'Student Name,Class\n'), 422, 'IMPORT_FILE_INVALID');
    expectError(await upload(t, Buffer.alloc(2 * 1024 * 1024 + 10, 'a')), 413, 'FILE_TOO_LARGE');
    await t.agent.post(`${API}/students/imports`).field('mode', 'EVERYTHING').field('locationId', t.moh.locationId).attach('file', Buffer.from(HEADER), { filename: 'a.csv' }).expect(400);
    const template = await t.agent.get(`${API}/students/imports/template.csv`).expect(200);
    expect(template.text).toContain('Student Name,Date of Birth');
    // New admissions with automatic numbers need no admission number in the file.
    const fresh = (await upload(t, 'Student Name,Class,Section,Father Name,Father Mobile\nNew Kid,VIII,A,New Dad,+91 98140 77777\n', 'NEW_ADMISSIONS').expect(201)).body.data as ImportDTO;
    expect((await post<ImportDTO>(t.agent, `/students/imports/${fresh.importId}/validate`)).summary.ready).toBe(1);
    expect(await post<ImportCommitResultDTO>(t.agent, `/students/imports/${fresh.importId}/commit`)).toMatchObject({ imported: 1 });
    expect((await get<{ items: { admissionNumber: string }[] }>(t.agent, '/students?q=New Kid')).items[0]!.admissionNumber).toMatch(/^GPS\/2026\/\d{5}$/);
    // Imports need the import permission.
    const staff = await createUserAndLogin(t.tenantId, 'STAFF');
    expect((await staff.agent.get(`${API}/students/imports`)).status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────── student context for other modules

describe('Student context for other modules (Module 4, Part 3 · F)', () => {
  it('returns where a student is on a date, from the effective-dated rows; the roster of a section; and refuses new records for a student who left', async () => {
    const t = await studentSchool();
    const a = await addStudent(t, { ...ADMITTED, rollNumber: '2' });
    const b = await addStudent(t, { ...ADMITTED, rollNumber: '1' });
    const ctx = t.ctx;

    const now = await studentService.getStudentContext(ctx, { studentId: a.student.studentId });
    expect(now).toMatchObject({ studentId: a.student.studentId, status: 'ACTIVE', locationName: 'Mohali Campus', rollNumber: '2', sectionId: t.sections.A, admissionNumber: a.student.admissionNumber });
    expect(now.classSection?.label).toBe('8-A');
    expect(now.subjects.map((s) => s.subjectName).sort()).toEqual(['Mathematics', 'Science']);
    // Before they joined there is nothing; for a session, the enrollment of that session.
    expect(await studentService.getStudentContext(ctx, { studentId: a.student.studentId, date: '2026-04-01' })).toMatchObject({ enrollmentId: null, classSection: null, subjects: [] });
    expect(await studentService.getStudentContext(ctx, { studentId: a.student.studentId, academicSessionId: t.sessionId })).toMatchObject({ academicSessionId: t.sessionId, rollNumber: '2' });

    // The same data for the UI, under the same rules.
    expect(await get<StudentContextDTO>(t.agent, `/student-context?studentId=${a.student.studentId}`)).toMatchObject({ rollNumber: '2', locationName: 'Mohali Campus' });
    expect(await get<StudentContextDTO>(t.agent, `/student-context?studentId=${a.student.studentId}&date=2026-04-01`)).toMatchObject({ enrollmentId: null });

    // The roster is ordered by roll number: this is the list later modules use.
    const roster = await studentService.listStudentsForSection(ctx, t.sections.A);
    expect(roster.map((r) => [r.rollNumber, r.studentId])).toEqual([['1', b.student.studentId], ['2', a.student.studentId]]);
    expect(await studentService.listStudentsForSection(ctx, t.sections.A, '2026-04-01')).toEqual([]);
    expect((await studentService.listGuardiansForStudent(ctx, a.student.studentId))).toHaveLength(1);

    // A move on a date: the old section still answers for the old days.
    await post(t.agent, `/students/${a.student.studentId}/section-transfer`, { toSectionId: t.sections.B, effectiveDate: addDays(today(), 5), reason: 'Request' });
    expect((await studentService.getStudentContext(ctx, { studentId: a.student.studentId, date: today() })).sectionId).toBe(t.sections.A);
    expect((await studentService.getStudentContext(ctx, { studentId: a.student.studentId, date: addDays(today(), 5) })).sectionId).toBe(t.sections.B);

    await expect(studentService.assertStudentUsable(ctx, a.student.studentId, 'NEW_RECORD')).resolves.toBe('ACTIVE');
    const draft = (await t.agent.post(`${API}/students`).send({ draft: true, legalFirstName: 'Draft', legalLastName: 'Kid' }).expect(201)).body.data.student;
    await expect(studentService.assertStudentUsable(ctx, draft.studentId, 'NEW_RECORD')).rejects.toMatchObject({ code: 'STUDENT_INCOMPLETE' });
    await expect(studentService.getStudentContext(serviceContextFor('another-tenant', t.ctx.userId), { studentId: a.student.studentId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
