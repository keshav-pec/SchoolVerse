import type { ClientSession } from 'mongoose';
import type { DuplicateCandidateDTO, DuplicateCheckData, DuplicateCheckResultDTO, DuplicateReason } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { Person, type PersonDoc } from '../staff/person.model';
import { fullNameOf, hydrateStudents } from './directory';
import { classSectionOf } from './mappers';
import { isSimilarName, nameKey } from './rules';
import { Student, StudentAdmission, StudentExternalId, StudentGuardianLink, type StudentAdmissionDoc, type StudentDoc, type StudentExternalIdDoc, type StudentGuardianLinkDoc } from './student.models';

/**
 * SPM-02 — possible duplicate students. It only ever says "this looks like", with a reason for each match. It never merges
 * or blocks by itself: Quick Add asks the admin to confirm (`confirmNotDuplicate`).
 */
export async function findDuplicateCandidates(ctx: ServiceContext, input: DuplicateCheckData, db?: ClientSession): Promise<DuplicateCandidateDTO[]> {
  const tenantId = ctx.tenantId;
  const reasons = new Map<string, Set<DuplicateReason>>();
  const add = (studentId: string, reason: DuplicateReason) => {
    if (studentId === input.excludeStudentId) return;
    reasons.set(studentId, (reasons.get(studentId) ?? new Set()).add(reason));
  };

  if (input.admissionNumber) {
    const row = await StudentAdmission.findOne({ tenantId, admissionNumber: input.admissionNumber }).session(db ?? null).select('studentId').lean<Pick<StudentAdmissionDoc, 'studentId'>>();
    if (row) add(row.studentId, 'SAME_ADMISSION_NUMBER');
  }

  for (const external of input.externalIds ?? []) {
    const rows = await StudentExternalId.find({ tenantId, type: external.type, value: external.value, effectiveTo: null })
      .collation({ locale: 'en', strength: 2 })
      .session(db ?? null)
      .select('studentId')
      .lean<Pick<StudentExternalIdDoc, 'studentId'>[]>();
    for (const row of rows) add(row.studentId, 'SAME_EXTERNAL_ID');
  }

  const key = nameKey(input.name);
  if (input.dateOfBirth) {
    const people = await Person.find({ tenantId, dateOfBirth: input.dateOfBirth }).session(db ?? null).lean<PersonDoc[]>();
    const sameDay = new Map(people.map((p) => [p._id, nameKey(p.legalFirstName, p.legalMiddleName, p.legalLastName)]));
    const students = sameDay.size ? await Student.find({ tenantId, personId: { $in: [...sameDay.keys()] } }).session(db ?? null).select('personId').lean<Pick<StudentDoc, '_id' | 'personId'>[]>() : [];
    for (const student of students) {
      const other = sameDay.get(student.personId)!;
      if (other === key) add(student._id, 'SAME_NAME_AND_DOB');
      else if (isSimilarName(other, key)) add(student._id, 'SIMILAR_NAME_AND_DOB');
    }
  }

  // The same parent contact and the same first name: probably the same child entered twice.
  const contact: Record<string, unknown>[] = [];
  if (input.guardianPhone) contact.push({ primaryPhone: input.guardianPhone }, { personalPhone: input.guardianPhone });
  if (input.guardianEmail) contact.push({ primaryEmail: input.guardianEmail }, { personalEmail: input.guardianEmail });
  if (contact.length > 0) {
    const guardians = await Person.find({ tenantId, $or: contact }).session(db ?? null).select('_id').lean<{ _id: string }[]>();
    const links = guardians.length ? await StudentGuardianLink.find({ tenantId, guardianPersonId: { $in: guardians.map((g) => g._id) }, cancelledAt: null }).session(db ?? null).select('studentId').lean<Pick<StudentGuardianLinkDoc, 'studentId'>[]>() : [];
    const kids = links.length ? await Student.find({ tenantId, _id: { $in: [...new Set(links.map((l) => l.studentId))] } }).session(db ?? null).lean<StudentDoc[]>() : [];
    const kidPeople = kids.length ? await Person.find({ tenantId, _id: { $in: kids.map((k) => k.personId) } }).session(db ?? null).lean<PersonDoc[]>() : [];
    const firstNameOf = new Map(kidPeople.map((p) => [p._id, nameKey(p.legalFirstName)]));
    const wanted = nameKey(input.name.trim().split(/\s+/)[0]);
    for (const kid of kids) if (firstNameOf.get(kid.personId) === wanted) add(kid._id, 'SAME_GUARDIAN_PHONE_AND_FIRST_NAME');
  }

  if (reasons.size === 0) return [];
  const students = await Student.find({ tenantId, _id: { $in: [...reasons.keys()] } }).session(db ?? null).lean<StudentDoc[]>();
  const h = await hydrateStudents(ctx, students, { db });
  return students.map((s) => {
    const placement = h.placements.get(s._id);
    return {
      studentId: s._id,
      fullName: fullNameOf(h.people.get(s.personId)!),
      admissionNumber: h.admissions.get(s._id)?.admissionNumber ?? null,
      status: s.status,
      classSection: classSectionOf(h.classes, h.sections, placement?.enrollment ?? null, placement?.assignment ?? null),
      reasons: [...reasons.get(s._id)!],
    };
  });
}

export async function duplicateCheck(ctx: ServiceContext, input: DuplicateCheckData): Promise<DuplicateCheckResultDTO> {
  return { candidates: await findDuplicateCandidates(ctx, input) };
}
