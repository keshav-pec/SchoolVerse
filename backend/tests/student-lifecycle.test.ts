import { describe, expect, it } from 'vitest';
import type { BulkPromotionResultDTO, ImportCommitResultDTO, ImportDTO, ImportIssuesDTO, ImportRowListDTO, LocationTransferResultDTO, LocationTransferValidationDTO, PromotionReadinessDTO, ReadmissionResultDTO, RepeatResultDTO, SignedFileLinkDTO, StudentAdminProfileDTO, StudentAttentionDTO, StudentContextDTO, StudentDocumentsDTO, StudentHistoryDTO, StudentTransfersDTO, TransferCertificateDTO, WithdrawalDTO, BulkInvitationResultDTO, DocumentCompletenessDTO, ParentAccessDTO, ParentChildrenDTO, ParentStudentSummaryDTO, StudentChangeRequestDTO, StudentChangeRequestListDTO, StudentDocumentDTO, StudentExportResultDTO } from '@shared';
import { addDays } from '../src/core/dates';
import { ClassOffering } from '../src/modules/academic/offering.model';
import { AcademicSession } from '../src/modules/academic/session.model';
import { Student, StudentAdmission, StudentEnrollment, StudentGuardianLink, StudentSectionAssignment, StudentSubjectEnrollment } from '../src/modules/students/student.models';
import { StudentImportRow, StudentTransferCertificate, StudentChangeRequest, StudentDocument } from '../src/modules/students/records.models';
import { processDueWithdrawals } from '../src/modules/students/jobs';
import { studentService } from '../src/modules/students/context.service';
import { API, activatedParent, addClasses, addStudent, createUserAndLogin, download, expectError, forceStatus, guardianLinks, inviteParent, nextPhone, offer, promotionSchool, serviceContextFor, studentBody, studentSchool, today, useTestDatabase, type Agent, type StudentSchool, EICAR, PASSWORD, PDF, PNG, addEmployee, app, loginAs, outboxLink, teacherWith, tokenFromLink, uploadDocument } from './helpers';
import request from 'supertest';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { Person } from '../src/modules/staff/person.model';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { User } from '../src/platform/users/user.model';
import { DEMO_PASSWORD, seedDemo } from '../src/scripts/seed';
import { Tenant } from '../src/platform/tenants/tenant.model';

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

// ───────────────────────────────────────────────────────────── Needs Attention (Part 4)

describe('Needs Attention for parent access, exits, duplicates and follow-up work (Module 4, Part 4)', () => {
  it('lists invitations not accepted, removed access, certificates on their way, possible duplicate students, missing documents and promotion review; the badge counts only the fix-now groups', async () => {
    const t = await promotionSchool();
    const guardian = (first: string) => ({ legalFirstName: first, legalLastName: 'Parent', phone: nextPhone(), email: `${first.toLowerCase()}.p4@greenfield.demo`, relationshipType: 'Mother' });
    const invited = await addStudent(t, { ...ADMITTED, legalFirstName: 'Invited', guardian: guardian('Ivy') });
    const revoked = await addStudent(t, { ...ADMITTED, legalFirstName: 'Revoked', guardian: guardian('Rhea') });
    const signedIn = await addStudent(t, { ...ADMITTED, legalFirstName: 'Signed', guardian: guardian('Sana') });
    const leaving = await addStudent(t, { ...ADMITTED, legalFirstName: 'Leaving' });
    await addStudent(t, { ...ADMITTED, legalFirstName: 'Stuck', classOfferingId: t.nine.classOfferingId, sectionId: t.nine.sections.A }); // no Class X next year
    await addStudent(t, { ...ADMITTED, legalFirstName: 'Same', legalLastName: 'Child', dateOfBirth: '2014-05-10' });
    await addStudent(t, { ...ADMITTED, legalFirstName: 'Same', legalLastName: 'Child', dateOfBirth: '2014-05-10', confirmNotDuplicate: true });

    await inviteParent(t, invited.student.studentId, 'ivy.p4@greenfield.demo');
    const { linkId } = await inviteParent(t, revoked.student.studentId, 'rhea.p4@greenfield.demo');
    await post(t.agent, `/guardian-links/${linkId}/revoke-portal`);
    await activatedParent(t, signedIn.student.studentId, 'sana.p4@greenfield.demo');
    await post(t.agent, `/students/${leaving.student.studentId}/transfer-certificates`, { reasonForLeaving: 'Moving' }, 201);

    const attention = await get<StudentAttentionDTO>(t.agent, `/students/attention?academicSessionId=${t.sessionId}&locationId=${t.moh.locationId}`);
    const group = (key: string) => attention.groups.find((g) => g.key === key)!;
    const first = (key: string) => group(key).items.map((i) => i.fullName.split(' ')[0]);

    expect(group('PARENT_ACCESS').items.map((i) => [i.fullName.split(' ')[0], i.fix])).toEqual([['Invited', 'INVITE_PARENT'], ['Revoked', 'INVITE_PARENT']]);
    expect(group('PARENT_ACCESS').items[0]!.message).toMatch(/Ivy Parent was invited but has not signed in/);
    expect(first('EXIT')).toEqual(['Leaving']);
    expect(group('EXIT').items[0]).toMatchObject({ fix: 'FINISH_EXIT', message: expect.stringMatching(/transfer certificate/i) });
    expect(first('DATA_QUALITY')).toEqual(['Same', 'Same']);
    expect(group('DATA_QUALITY').items[0]!.fix).toBe('OPEN_STUDENT');

    // Follow-up: nobody has documents yet, and the Class IX student has no class next year.
    expect(group('DOCUMENTS').followUp).toBe(true);
    expect(group('DOCUMENTS').items).toHaveLength(7);
    expect(group('DOCUMENTS').items[0]).toMatchObject({ fix: 'UPLOAD_DOCUMENT', message: expect.stringMatching(/^0 of 4 done\. Missing: Birth certificate/) });
    expect(group('PROMOTION').items.map((i) => [i.fullName.split(' ')[0], i.fix])).toEqual([['Stuck', 'REVIEW_PROMOTION']]);
    expect(group('PROMOTION').items[0]!.message).toMatch(/next year/i);

    // Invited, Revoked, Leaving and the two Same children; documents and promotion are follow-up only.
    expect(attention.counts).toMatchObject({ activeStudents: 7, needsAttention: 5, followUp: 8, portalActivationPercent: 14, withdrawalsThisYear: 0 });
  });
});

const parentEmail = (n: number) => `parent${n}.p3@greenfield.demo`;

/** A school with one student whose mother has an activated parent login. */
async function familyWithLogin(n = 1) {
  const t = await studentSchool();
  const email = parentEmail(n);
  const kid = await addStudent(t, { guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone: nextPhone(), email, relationshipType: 'Mother' } });
  const parent = await activatedParent(t, kid.student.studentId, email);
  return { t, kid, parent, email };
}

// ───────────────────────────────────────────────────────────── parent login and access

describe('Parent login and parent-only access (Module 4, Part 3 · A)', () => {
  it('QA P1: enabling access reuses an existing Parent login instead of making a second one', async () => {
    const t = await studentSchool();
    const email = parentEmail(11);
    const kid = await addStudent(t, { guardian: { legalFirstName: 'Gita', legalLastName: 'Rao', phone: nextPhone(), email, relationshipType: 'Mother' } });
    // The login already exists (the demo Parent account): it has no person yet.
    await User.create({ tenantId: t.tenantId, email, fullName: 'Gita Rao', role: 'PARENT', status: 'ACTIVE', passwordHash: null });
    const { access } = await inviteParent(t, kid.student.studentId, email);
    expect(access).toMatchObject({ portalState: 'ACTIVE', reusedAccount: true, invitationSent: false, hasLogin: true });
    const users = await User.find({ tenantId: t.tenantId, email }).lean();
    expect(users).toHaveLength(1);
    expect(users[0]!.personId).toBeTruthy();
  });

  it('QA P2: a sibling under the same parent does not create a second account', async () => {
    const t = await studentSchool();
    const email = parentEmail(12);
    const first = await addStudent(t, { guardian: { legalFirstName: 'Anita', legalLastName: 'Kohli', phone: nextPhone(), email, relationshipType: 'Mother' } });
    const parentPerson = (await guardianLinks(t.agent, first.student.studentId))[0]!.guardianPersonId;
    const second = await addStudent(t, { guardian: { guardianPersonId: parentPerson, relationshipType: 'Mother' } });
    const a = await inviteParent(t, first.student.studentId, email);
    const b = await inviteParent(t, second.student.studentId, email);
    expect(a.access).toMatchObject({ invitationSent: true, reusedAccount: false });
    expect(b.access).toMatchObject({ invitationSent: false, reusedAccount: true });
    expect(await User.countDocuments({ tenantId: t.tenantId, role: 'PARENT', email })).toBe(1);
  });

  it('QA P3: a parent who has not activated cannot sign in, and the activation link works once', async () => {
    const t = await studentSchool();
    const email = parentEmail(13);
    const kid = await addStudent(t, { guardian: { legalFirstName: 'Rani', legalLastName: 'Sethi', phone: nextPhone(), email, relationshipType: 'Mother' } });
    const { access } = await inviteParent(t, kid.student.studentId, email);
    expect(access.portalState).toBe('INVITED');
    await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(401);
    const token = tokenFromLink(await outboxLink(email, 'ACTIVATION'));
    await request(app).post(`${API}/auth/activate`).send({ token, password: PASSWORD }).expect(200);
    expectError(await request(app).post(`${API}/auth/activate`).send({ token, password: PASSWORD }), 400, 'TOKEN_INVALID');
    await request.agent(app).post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(200);
    const access2 = (await get<ParentAccessDTO[]>(t.agent, `/students/${kid.student.studentId}/parent-access`))[0]!;
    expect(access2).toMatchObject({ portalState: 'ACTIVE', accountStatus: 'ACTIVE' });
  });

  it('a guardian without an email, without access flags, or whose email belongs to a staff login cannot be invited', async () => {
    const t = await studentSchool();
    const noEmail = await addStudent(t, { guardian: { legalFirstName: 'Sita', legalLastName: 'Das', phone: nextPhone(), relationshipType: 'Mother' } });
    const link = (await guardianLinks(t.agent, noEmail.student.studentId))[0]!;
    expectError(await t.agent.post(`${API}/guardian-links/${link.guardianLinkId}/enable-portal`), 422, 'GUARDIAN_EMAIL_REQUIRED');

    const email = parentEmail(14);
    const emergency = await addStudent(t, { guardian: { legalFirstName: 'Kamla', legalLastName: 'Das', phone: nextPhone(), email, relationshipType: 'Grandmother', canSeeAcademics: false, canSeeFees: false } });
    const link2 = (await guardianLinks(t.agent, emergency.student.studentId))[0]!;
    expectError(await t.agent.post(`${API}/guardian-links/${link2.guardianLinkId}/enable-portal`), 400, 'VALIDATION_FAILED');

    const staffEmail = parentEmail(15);
    await createUserAndLogin(t.tenantId, 'STAFF').then(({ userId }) => User.updateOne({ _id: userId, tenantId: t.tenantId }, { $set: { email: staffEmail } }));
    const clash = await addStudent(t, { guardian: { legalFirstName: 'Lata', legalLastName: 'Das', phone: nextPhone(), email: staffEmail, relationshipType: 'Mother' } });
    const link3 = (await guardianLinks(t.agent, clash.student.studentId))[0]!;
    expectError(await t.agent.post(`${API}/guardian-links/${link3.guardianLinkId}/enable-portal`), 409, 'PARENT_EMAIL_IN_USE');
  });

  it('QA P4: removing access for one child leaves the parent’s login and the other child', async () => {
    const t = await studentSchool();
    const email = parentEmail(16);
    const first = await addStudent(t, { guardian: { legalFirstName: 'Nisha', legalLastName: 'Bajwa', phone: nextPhone(), email, relationshipType: 'Mother' } });
    const person = (await guardianLinks(t.agent, first.student.studentId))[0]!.guardianPersonId;
    const second = await addStudent(t, { guardian: { guardianPersonId: person, relationshipType: 'Mother' } });
    const parent = await activatedParent(t, first.student.studentId, email);
    const link2 = await inviteParent(t, second.student.studentId, email);
    expect((await get<ParentChildrenDTO>(parent.agent, '/parent/children')).children).toHaveLength(2);

    const revoked = await post<ParentAccessDTO>(t.agent, `/guardian-links/${parent.linkId}/revoke-portal`);
    expect(revoked.portalState).toBe('REVOKED');
    const children = (await get<ParentChildrenDTO>(parent.agent, '/parent/children')).children;
    expect(children.map((c) => c.studentId)).toEqual([second.student.studentId]);
    expect(link2.access.portalState).toBe('ACTIVE');
    await parent.agent.get(`${API}/parent/children/${first.student.studentId}`).expect(404);
    await parent.agent.get(`${API}/parent/children/${second.student.studentId}`).expect(200);
  });

  it('QA P5: removing access takes effect on the very next request', async () => {
    const { t, kid, parent } = await familyWithLogin(21);
    await parent.agent.get(`${API}/parent/children/${kid.student.studentId}`).expect(200);
    await post(t.agent, `/guardian-links/${parent.linkId}/revoke-portal`);
    expectError(await parent.agent.get(`${API}/parent/children/${kid.student.studentId}`), 404, 'NOT_FOUND');
    // Access can be given again: the login is still there.
    const again = await post<ParentAccessDTO>(t.agent, `/guardian-links/${parent.linkId}/enable-portal`);
    expect(again).toMatchObject({ portalState: 'ACTIVE', reusedAccount: true });
    await parent.agent.get(`${API}/parent/children/${kid.student.studentId}`).expect(200);
  });

  it('QA P6: a suspended parent account loses every session', async () => {
    const { t, parent } = await familyWithLogin(22);
    const user = await User.findOne({ tenantId: t.tenantId, email: parent.email }).lean();
    await parent.agent.get(`${API}/parent/children`).expect(200);
    await post(t.agent, `/users/${user!._id}/suspend`, { reason: 'Requested by the family' });
    const res = await parent.agent.get(`${API}/parent/children`);
    expect([401, 403]).toContain(res.status);
  });

  it('QA P7: a parent who asks for another student’s id gets 404, and a security event is written', async () => {
    const { t, kid, parent } = await familyWithLogin(23);
    const other = await addStudent(t);
    expectError(await parent.agent.get(`${API}/parent/children/${other.student.studentId}`), 404, 'NOT_FOUND');
    expectError(await parent.agent.get(`${API}/parent/children/${other.student.studentId}/documents`), 404, 'NOT_FOUND');
    expectError(await parent.agent.get(`${API}/student-context`).query({ studentId: other.student.studentId }), 404, 'NOT_FOUND');
    expectError(await parent.agent.post(`${API}/parent/children/${other.student.studentId}/change-requests`).send({ field: 'DATE_OF_BIRTH', value: { dateOfBirth: '2014-01-01' } }), 404, 'NOT_FOUND');
    expect(await get<ParentStudentSummaryDTO>(parent.agent, `/parent/children/${kid.student.studentId}`)).toMatchObject({ studentId: kid.student.studentId });
    const events = await SecurityEvent.find({ tenantId: t.tenantId, type: 'PARENT_ACCESS_DENIED', targetId: other.student.studentId }).lean();
    expect(events.length).toBeGreaterThanOrEqual(3);
    // Ids and categories only.
    expect(JSON.stringify(events)).not.toContain(parent.email);
  });

  it('QA P8: a parent cannot use admin or faculty routes, and nobody else can use the parent routes', async () => {
    const { t, kid, parent } = await familyWithLogin(24);
    for (const path of ['/students', `/students/${kid.student.studentId}`, '/guardians', '/employees', '/promotions/readiness', '/students/imports', '/student-change-requests', `/students/${kid.student.studentId}/documents`]) {
      const res = await parent.agent.get(`${API}${path}`);
      expect(res.status, path).toBe(403);
    }
    await parent.agent.post(`${API}/students/exports`).send({ purpose: 'DIRECTORY' }).expect(403);
    await parent.agent.post(`${API}/students/${kid.student.studentId}/withdrawal`).send({ leavingDate: '2026-12-01', reasonCategory: 'OTHER', needsTC: false }).expect(403);
    await t.agent.get(`${API}/parent/children`).expect(403);
    const teacher = await teacherWith(t, [{ assignmentType: 'CLASS_TEACHER', sectionId: t.sections.A }]);
    await teacher.agent.get(`${API}/parent/children`).expect(403);
  });

  it('QA P9: ending a guardian link ends access, and the history stays', async () => {
    const { t, kid, parent } = await familyWithLogin(25);
    await post(t.agent, `/guardian-links/${parent.linkId}/end`, {});
    expectError(await parent.agent.get(`${API}/parent/children/${kid.student.studentId}`), 404, 'NOT_FOUND');
    expect((await get<ParentChildrenDTO>(parent.agent, '/parent/children')).children).toHaveLength(0);
    const history = await get<{ entries: { kind: string; title: string }[] }>(t.agent, `/students/${kid.student.studentId}/history`);
    expect(history.entries.some((e) => e.kind === 'GUARDIAN' && /linked as Mother/.test(e.title))).toBe(true);
    expect(history.entries.some((e) => e.kind === 'GUARDIAN' && /link ended/.test(e.title))).toBe(true);
    expect(await StudentGuardianLink.countDocuments({ tenantId: t.tenantId, _id: parent.linkId })).toBe(1);
  });

  it('bulk invitations: invites, reuses a login for the second child, and skips (with a reason) a parent without an email', async () => {
    const t = await studentSchool();
    const email = parentEmail(31);
    const a = await addStudent(t, { guardian: { legalFirstName: 'Poonam', legalLastName: 'Bhatia', phone: nextPhone(), email, relationshipType: 'Mother' } });
    const person = (await guardianLinks(t.agent, a.student.studentId))[0]!.guardianPersonId;
    const b = await addStudent(t, { guardian: { guardianPersonId: person, relationshipType: 'Mother' } });
    const c = await addStudent(t, { guardian: { legalFirstName: 'Raj', legalLastName: 'Nair', phone: nextPhone(), relationshipType: 'Father' } });
    const ids = [a, b, c].map(async (k) => (await guardianLinks(t.agent, k.student.studentId))[0]!.guardianLinkId);
    const summary = await post<BulkInvitationResultDTO>(t.agent, '/parents/invitations/bulk', { guardianLinkIds: await Promise.all(ids) });
    expect(summary).toMatchObject({ invited: 1, reusedAccount: 1 });
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]!.reason).toMatch(/email/i);
    // By filter: nobody is left to invite except the parent without an email, who is skipped again.
    const again = await post<BulkInvitationResultDTO>(t.agent, '/parents/invitations/bulk', { filter: { classOfferingId: t.classOfferingId } });
    expect(again.invited + again.reusedAccount).toBe(0);
    await t.agent.post(`${API}/parents/invitations/bulk`).send({ guardianLinkIds: ['not-an-id'] }).expect(400);
    await t.agent.post(`${API}/parents/invitations/bulk`).send({}).expect(400);
  });

  it('QA S3 (parent): the parent summary carries only internal fields: no contact, notes, birth date or outside IDs', async () => {
    const { t, kid, parent } = await familyWithLogin(26);
    await t.agent.patch(`${API}/students/${kid.student.studentId}`).send({ version: kid.student.version, dateOfBirth: '2014-05-10', notes: 'SECRET-NOTE-123', bloodGroup: 'A+' }).expect(200);
    await t.agent.post(`${API}/students/${kid.student.studentId}/external-ids`).send({ type: 'Board Reg No', value: 'BRN-998877' }).expect(201);
    const summary = await parent.agent.get(`${API}/parent/children/${kid.student.studentId}`).expect(200);
    const text = JSON.stringify(summary.body);
    for (const secret of ['SECRET-NOTE-123', 'BRN-998877', '2014-05-10', 'dateOfBirth', 'phone', 'email', 'address', 'bloodGroup', 'notes', 'externalIds']) expect(text, secret).not.toContain(secret);
    expect(Object.keys(summary.body.data).sort()).toEqual(['admissionNumber', 'campusName', 'classSection', 'displayName', 'fullName', 'hasPhoto', 'primaryGuardianName', 'rollNumber', 'studentId', 'subjects']);
  });

  it('QA S8: a staff login with no student permission is refused everywhere in this module', async () => {
    const t = await studentSchool();
    const kid = await addStudent(t);
    const staff = await createUserAndLogin(t.tenantId, 'STAFF');
    for (const path of ['/students', `/students/${kid.student.studentId}/documents`, `/students/${kid.student.studentId}/parent-access`, '/student-change-requests', '/students/imports', '/promotions/readiness?fromSessionId=x']) {
      expect((await staff.agent.get(`${API}${path}`)).status, path).toBe(403);
    }
    expect((await staff.agent.get(`${API}/student-context`).query({ studentId: kid.student.studentId })).status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────── documents and change requests

describe('Student documents and parent change requests (Module 4, Part 3 · B)', () => {
  it('uploads a document, shows the checklist, and a parent sees only the types meant for them', async () => {
    const { t, kid, parent } = await familyWithLogin(41);
    const url = `/students/${kid.student.studentId}/documents`;
    let docs = await get<StudentDocumentsDTO>(t.agent, url);
    expect(docs.completeness).toMatchObject({ total: 4, done: 0 });
    const birth = (await uploadDocument(t.agent, `${API}${url}`, PDF, { documentType: 'BIRTH_CERTIFICATE', displayName: 'Birth certificate' }).expect(201)).body.data as StudentDocumentDTO;
    const medical = (await uploadDocument(t.agent, `${API}${url}`, PNG, { documentType: 'MEDICAL' }, 'check.png').expect(201)).body.data as StudentDocumentDTO;
    expect(birth).toMatchObject({ documentType: 'BIRTH_CERTIFICATE', mime: 'application/pdf', issuedBySchool: false });
    docs = await get<StudentDocumentsDTO>(t.agent, url);
    expect(docs.items).toHaveLength(2);
    const completeness: DocumentCompletenessDTO = docs.completeness;
    expect(completeness.message).toBe('1 of 4 done. Missing: Previous school record, ID proof, Photo');

    const seen = await get<StudentDocumentDTO[]>(parent.agent, `/parent/children/${kid.student.studentId}/documents`);
    expect(seen.map((d) => d.documentId)).toEqual([birth.documentId]);
    // A parent downloads a document meant for them, and cannot download a medical one.
    const link = await post<SignedFileLinkDTO>(parent.agent, `/student-documents/${birth.documentId}/download`);
    expect((await download(link.url)).body.subarray(0, 5).toString()).toBe('%PDF-');
    expectError(await parent.agent.post(`${API}/student-documents/${medical.documentId}/download`), 404, 'NOT_FOUND');
  });

  it('QA S4: a download needs authorization; a tampered or expired link fails; another family cannot download', async () => {
    const { t, kid } = await familyWithLogin(42);
    const other = await familyWithLogin(43);
    const doc = (await uploadDocument(t.agent, `${API}/students/${kid.student.studentId}/documents`, PDF, { documentType: 'ID_PROOF' }).expect(201)).body.data as StudentDocumentDTO;
    // No login at all.
    expect((await request(app).post(`${API}/student-documents/${doc.documentId}/download`)).status).toBe(401);
    // A parent of another school: 404, and our rows are never even looked at.
    expectError(await other.parent.agent.post(`${API}/student-documents/${doc.documentId}/download`), 404, 'NOT_FOUND');
    const staff = await createUserAndLogin(t.tenantId, 'STAFF');
    expectError(await staff.agent.post(`${API}/student-documents/${doc.documentId}/download`), 404, 'NOT_FOUND');
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'DOCUMENT_ACCESS_DENIED' })).toBeGreaterThanOrEqual(1);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'student_document.download_denied' })).toBe(1); // the other school's parent never reaches this school's rows, so there is nothing of ours to audit

    const link = await post<SignedFileLinkDTO>(t.agent, `/student-documents/${doc.documentId}/download`);
    expect((await download(link.url)).status).toBe(200);
    const tampered = link.url.slice(0, -4) + 'AAAA';
    expect((await download(tampered)).error?.code).toBe('TOKEN_INVALID');
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'student_document.downloaded' })).toBeGreaterThanOrEqual(1);
  });

  it('QA S5: a wrong file type, an oversized file and an antivirus test file are all refused', async () => {
    const { t, kid } = await familyWithLogin(44);
    const url = `${API}/students/${kid.student.studentId}/documents`;
    expectError(await uploadDocument(t.agent, url, Buffer.from('<html><script>alert(1)</script></html>'), { documentType: 'OTHER' }, 'page.pdf'), 415, 'UNSUPPORTED_DOCUMENT_TYPE');
    expectError(await uploadDocument(t.agent, url, Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024 + 10)]), { documentType: 'OTHER' }), 413, 'DOCUMENT_TOO_LARGE');
    expectError(await uploadDocument(t.agent, url, EICAR, { documentType: 'OTHER' }), 422, 'FILE_REJECTED');
    expect(await StudentDocument.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'FILE_REJECTED' })).toBe(2);
    // A parent cannot upload at all.
    const parent = await activatedParent(t, (await addStudent(t, { guardian: { legalFirstName: 'Uma', legalLastName: 'K', phone: nextPhone(), email: parentEmail(45), relationshipType: 'Mother' } })).student.studentId, parentEmail(45));
    expect((await uploadDocument(parent.agent, url, PDF, { documentType: 'OTHER' })).status).toBe(403);
  });

  it('a document can be deleted: the file goes, the row stays for the audit trail', async () => {
    const { t, kid } = await familyWithLogin(46);
    const url = `${API}/students/${kid.student.studentId}/documents`;
    const doc = (await uploadDocument(t.agent, url, PDF, { documentType: 'PHOTO' }, 'photo.pdf').expect(201)).body.data as StudentDocumentDTO;
    await t.agent.delete(`${API}/student-documents/${doc.documentId}`).expect(204);
    expect((await get<StudentDocumentsDTO>(t.agent, `/students/${kid.student.studentId}/documents`)).items).toHaveLength(0);
    expect(await StudentDocument.findOne({ tenantId: t.tenantId, _id: doc.documentId }).lean()).toMatchObject({ status: 'DELETED' });
    expectError(await t.agent.post(`${API}/student-documents/${doc.documentId}/download`), 404, 'NOT_FOUND');
    // A draft that has a document cannot be discarded: the document counts as history.
    const draft = (await t.agent.post(`${API}/students`).send({ draft: true, legalFirstName: 'Draft', legalLastName: 'Kid' }).expect(201)).body.data.student;
    await uploadDocument(t.agent, `${API}/students/${draft.studentId}/documents`, PDF, { documentType: 'PHOTO' }, 'p.pdf').expect(201);
    expectError(await t.agent.delete(`${API}/students/${draft.studentId}`), 409, 'STUDENT_HAS_HISTORY');
  });

  it('a parent asks for a change; one request per detail; the admin approves it and it is applied once, with no value in the audit trail', async () => {
    const { t, kid, parent } = await familyWithLogin(51);
    const path = `/parent/children/${kid.student.studentId}/change-requests`;
    const asked = await post<StudentChangeRequestDTO>(parent.agent, path, { field: 'DATE_OF_BIRTH', value: { dateOfBirth: '2013-12-25' }, reason: 'Wrong year on the form' }, 201);
    expect(asked).toMatchObject({ status: 'PENDING', field: 'DATE_OF_BIRTH', newValue: 'Born in 2013', oldValue: 'Not set' });
    expectError(await parent.agent.post(`${API}${path}`).send({ field: 'DATE_OF_BIRTH', value: { dateOfBirth: '2012-01-01' } }), 409, 'CHANGE_REQUEST_PENDING');
    await post(parent.agent, path, { field: 'LEGAL_NAME', value: { legalFirstName: 'Kiddo', legalLastName: 'Learner' } }, 201);

    const list = await get<StudentChangeRequestListDTO>(t.agent, '/student-change-requests?status=PENDING');
    expect(list).toMatchObject({ total: 2, pendingCount: 2 });
    // The admin sees masked values: a birth date shows only the year.
    expect(JSON.stringify(list)).not.toContain('2013-12-25');
    const approved = await post<StudentChangeRequestDTO>(t.agent, `/student-change-requests/${asked.changeRequestId}/approve`, { note: 'Checked the birth certificate' });
    expect(approved).toMatchObject({ status: 'APPROVED', decisionNote: 'Checked the birth certificate' });
    expect((await get<{ dateOfBirth: string; version: number }>(t.agent, `/students/${kid.student.studentId}`)).dateOfBirth).toBe('2013-12-25');
    expectError(await t.agent.post(`${API}/student-change-requests/${asked.changeRequestId}/approve`).send({}), 409, 'CHANGE_REQUEST_CLOSED');
    expect(JSON.stringify(await AuditEvent.find({ tenantId: t.tenantId, action: { $in: ['change_request.created', 'change_request.approved', 'student.updated'] } }).lean())).not.toContain('2013-12-25');

    // Rejecting needs a note, and nothing changes.
    const name = list.items.find((r) => r.field === 'LEGAL_NAME')!;
    await t.agent.post(`${API}/student-change-requests/${name.changeRequestId}/reject`).send({}).expect(400);
    const rejected = await post<StudentChangeRequestDTO>(t.agent, `/student-change-requests/${name.changeRequestId}/reject`, { note: 'Please bring the document to the office.' });
    expect(rejected.status).toBe('REJECTED');
    expect((await get<{ legalFirstName: string }>(t.agent, `/students/${kid.student.studentId}`)).legalFirstName).toBe(kid.student.legalFirstName);

    // The parent sees the states, with the school's note, and nobody else's requests.
    const mine = await get<StudentChangeRequestDTO[]>(parent.agent, '/parent/change-requests');
    expect(mine.map((r) => r.status).sort()).toEqual(['APPROVED', 'REJECTED']);
    expect(mine.find((r) => r.status === 'REJECTED')!.decisionNote).toBe('Please bring the document to the office.');
  });

  it('a contact change applies to the parent once, for every child; a parent can cancel a waiting request but not another parent’s', async () => {
    const { t, kid, parent, email } = await familyWithLogin(52);
    const other = await familyWithLogin(53);
    const path = `/parent/children/${kid.student.studentId}/change-requests`;
    const phone = '+91 98765 11111';
    const asked = await post<StudentChangeRequestDTO>(parent.agent, path, { field: 'GUARDIAN_CONTACT', value: { phone } }, 201);
    expect(asked.newValue).toMatch(/1111/);
    expect(asked.newValue).not.toContain('98765');
    expectError(await other.parent.agent.post(`${API}/parent/change-requests/${asked.changeRequestId}/cancel`), 404, 'NOT_FOUND');
    await post(t.agent, `/student-change-requests/${asked.changeRequestId}/approve`, {});
    const person = await Person.findOne({ tenantId: t.tenantId, primaryEmail: email }).lean();
    expect(person!.primaryPhone).toBe('+919876511111');
    const second = await post<StudentChangeRequestDTO>(parent.agent, path, { field: 'GUARDIAN_CONTACT', value: { phone: '+91 98765 22222' } }, 201);
    const cancelled = await post<StudentChangeRequestDTO>(parent.agent, `/parent/change-requests/${second.changeRequestId}/cancel`);
    expect(cancelled.status).toBe('CANCELLED');
    expect(await StudentChangeRequest.countDocuments({ tenantId: t.tenantId, status: 'PENDING' })).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────── security and the demo seed

describe('Child-data security and the Part 3 demo seed', () => {
  it('QA S1 (faculty): a teacher cannot read an unassigned student, by id, in lists or through the context route', async () => {
    const t = await studentSchool();
    const mine = await addStudent(t, { sectionId: t.sections.A });
    const theirs = await addStudent(t, { sectionId: t.sections.B });
    const teacher = await teacherWith(t, [{ assignmentType: 'CLASS_TEACHER', sectionId: t.sections.A }]);
    expect((await get<{ items: { studentId: string }[] }>(teacher.agent, '/students')).items.map((s) => s.studentId)).toEqual([mine.student.studentId]);
    expectError(await teacher.agent.get(`${API}/students/${theirs.student.studentId}`), 404, 'NOT_FOUND');
    expectError(await teacher.agent.get(`${API}/student-context`).query({ studentId: theirs.student.studentId }), 404, 'NOT_FOUND');
    expect((await teacher.agent.get(`${API}/student-context`).query({ studentId: mine.student.studentId })).status).toBe(200);
    for (const path of [`/students/${mine.student.studentId}/documents`, `/students/${mine.student.studentId}/parent-access`, `/students/${mine.student.studentId}/withdrawal`]) expect((await teacher.agent.get(`${API}${path}`)).status, path).toBe(403);
  });

  it('QA S2: another school’s ids are 404 on every Part 3 route, and another school’s parent has no access', async () => {
    const a = await studentSchool('School A');
    const b = await studentSchool('School B');
    const kid = await addStudent(a);
    const link = (await guardianLinks(a.agent, kid.student.studentId))[0]!;
    const doc = (await uploadDocument(a.agent, `${API}/students/${kid.student.studentId}/documents`, PDF, { documentType: 'ID_PROOF' }).expect(201)).body.data as StudentDocumentDTO;
    const tc = (await a.agent.post(`${API}/students/${kid.student.studentId}/transfer-certificates`).send({}).expect(201)).body.data as { certificateId: string };
    const calls: [string, string, object?][] = [
      ['get', `/students/${kid.student.studentId}/documents`],
      ['get', `/students/${kid.student.studentId}/parent-access`],
      ['get', `/students/${kid.student.studentId}/withdrawal`],
      ['get', `/students/${kid.student.studentId}/transfers`],
      ['get', `/students/${kid.student.studentId}/transfer-certificates`],
      ['post', `/guardian-links/${link.guardianLinkId}/enable-portal`],
      ['post', `/guardian-links/${link.guardianLinkId}/revoke-portal`],
      ['post', `/student-documents/${doc.documentId}/download`],
      ['post', `/transfer-certificates/${tc.certificateId}/approve`],
      ['post', `/students/${kid.student.studentId}/withdrawal`, { leavingDate: '2026-12-01', reasonCategory: 'OTHER', needsTC: false }],
      ['post', `/students/${kid.student.studentId}/readmit`, { academicSessionId: a.sessionId, locationId: a.moh.locationId, classOfferingId: a.classOfferingId }],
    ];
    for (const [method, path, body] of calls) {
      const res = await (b.agent as unknown as Record<string, (u: string) => request.Test>)[method]!(`${API}${path}`).send(body ?? {});
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    await b.agent.delete(`${API}/student-documents/${doc.documentId}`).expect(404);
  });

  it('QA S6: an export needs its own permission, escapes formulas, and has no restricted columns', async () => {
    const t = await studentSchool();
    await addStudent(t, { legalFirstName: '=HYPERLINK("http://evil")', legalLastName: 'Learner', dateOfBirth: '2014-05-10', guardian: { legalFirstName: 'Pria', legalLastName: 'L', phone: '+91 98140 12345', email: parentEmail(61), relationshipType: 'Mother' } });
    const teacher = await teacherWith(t, [{ assignmentType: 'CLASS_TEACHER', sectionId: t.sections.A }]);
    expect((await teacher.agent.post(`${API}/students/exports`).send({ purpose: 'DIRECTORY' })).status).toBe(403);

    for (const purpose of ['DIRECTORY', 'ACADEMIC', 'GUARDIAN_CONTACTS'] as const) {
      const result = await post<StudentExportResultDTO>(t.agent, '/students/exports', { purpose, filters: {} }, 201);
      expect(result).toMatchObject({ purpose, rowCount: 1 });
      const csv = (await download(result.url)).body.toString('utf8');
      expect(csv, purpose).toContain("'=HYPERLINK");
      expect(csv, purpose).not.toMatch(/(^|,)=HYPERLINK/m);
      for (const secret of ['2014-05-10', 'dateOfBirth', 'Date of birth', 'Address', 'Notes', parentEmail(61)]) expect(csv, `${purpose} must not contain ${secret}`).not.toContain(secret);
      if (purpose === 'GUARDIAN_CONTACTS') expect(csv).toContain('+919814012345');
      else expect(csv).not.toContain('9814012345');
    }
    await t.agent.post(`${API}/students/exports`).send({ purpose: 'EVERYTHING' }).expect(400);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, entityType: 'student_export', action: 'student_export.created' })).toBe(3);
  });

  it('QA S7: logs, audit rows and security events hold no raw parent phone, email or birth date used in the tests', async () => {
    const { t, kid, parent, email } = await familyWithLogin(62);
    await t.agent.patch(`${API}/students/${kid.student.studentId}`).send({ version: kid.student.version, dateOfBirth: '2011-03-09' }).expect(200);
    await post(parent.agent, `/parent/children/${kid.student.studentId}/change-requests`, { field: 'GUARDIAN_CONTACT', value: { phone: '+91 98765 33333', email: 'new.contact.p3@greenfield.demo' } }, 201);
    await parent.agent.get(`${API}/parent/children/${(await addStudent(t)).student.studentId}`).expect(404);
    const everything = JSON.stringify([...(await AuditEvent.find({ tenantId: t.tenantId }).lean()), ...(await SecurityEvent.find({ tenantId: t.tenantId }).lean())]);
    for (const secret of [email, '2011-03-09', '9876533333', 'new.contact.p3@greenfield.demo']) expect(everything, secret).not.toContain(secret);
  });

  it('QA S9: the demo seed has only .demo emails and zero-style numbers, and sets up the parent portal cases', async () => {
    await seedDemo({ quiet: true });
    const tenant = await Tenant.findOne({ slug: 'greenfield-public-school' }).lean();
    const tenantId = tenant!._id;
    const studentPeople = await Student.find({ tenantId }).select('personId').lean();
    const guardians = await StudentGuardianLink.find({ tenantId }).select('guardianPersonId').lean();
    const people = await Person.find({ tenantId, _id: { $in: [...studentPeople.map((s) => s.personId), ...guardians.map((g) => g.guardianPersonId)] } }).lean();
    expect(people.length).toBeGreaterThan(40);
    for (const p of people) {
      if (p.primaryEmail) expect(p.primaryEmail, 'email').toMatch(/\.demo$/);
      if (p.primaryPhone) expect(p.primaryPhone, 'phone').toMatch(/^\+9190000\d{5}$/);
    }
    const parentUsers = await User.find({ tenantId, role: 'PARENT' }).lean();
    expect(parentUsers.every((u) => u.email.endsWith('.demo'))).toBe(true);

    // Simran has an activated login and two children.
    const simran = parentUsers.find((u) => u.email === 'parent@greenfield.demo')!;
    expect(simran).toMatchObject({ status: 'ACTIVE' });
    expect(simran.personId).toBeTruthy();
    const login = request.agent(app);
    await login.post(`${API}/auth/login`).send({ email: 'parent@greenfield.demo', password: DEMO_PASSWORD }).expect(200);
    expect((await get<ParentChildrenDTO>(login, '/parent/children')).children.map((c) => c.fullName).sort()).toEqual(['Arjun Kaur', 'Riya Kaur']);
    // One pending invitation, one removed access.
    expect(parentUsers.filter((u) => u.status === 'PENDING_ACTIVATION')).toHaveLength(2);
    expect(await StudentGuardianLink.countDocuments({ tenantId, portalRevokedAt: { $ne: null } })).toBe(1);
    // One student is leaving, one certificate waits for dues, and 2027-28 can take promotions.
    expect(await Student.countDocuments({ tenantId, status: 'WITHDRAWAL_INITIATED' })).toBe(1);
    expect(await StudentTransferCertificate.countDocuments({ tenantId, status: 'PENDING_CLEARANCE' })).toBe(1);
    expect(await AcademicSession.countDocuments({ tenantId, code: '2027-28', status: 'PUBLISHED' })).toBe(1);
  }, 60_000);

  it('QA S6 (employees): a teacher with a parent login on the same person is two logins, never one', async () => {
    // One user account has one role: a teacher who is also a parent needs a separate login with another email.
    const t = await studentSchool();
    const employee = await addEmployee(t);
    const login = await loginAs(t, 'FACULTY', employee);
    const kid = await addStudent(t, { guardian: { legalFirstName: 'Teach', legalLastName: 'Parent', phone: nextPhone(), email: parentEmail(63), relationshipType: 'Mother' } });
    const link = (await guardianLinks(t.agent, kid.student.studentId))[0]!;
    await Person.updateOne({ _id: link.guardianPersonId, tenantId: t.tenantId }, { $set: { primaryEmail: await User.findOne({ _id: login.userId, tenantId: t.tenantId }).then((u) => u!.email) } });
    expectError(await t.agent.post(`${API}/guardian-links/${link.guardianLinkId}/enable-portal`), 409, 'PARENT_EMAIL_IN_USE');
  });
});
