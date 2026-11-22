import type { ClientSession } from 'mongoose';
import { Person } from '../../staff/person.model';
import { Student, StudentAdmission } from '../../students/student.models';
import type { FinanceCtx } from './context';

/** Names for a batch of students, in two queries. Finance never keeps a copy of a name. */
export interface StudentLabel {
  studentId: string;
  name: string;
  admissionNumber: string | null;
  personId: string;
}

export async function studentLabels(f: Pick<FinanceCtx, 'tenantId'>, studentIds: string[], db?: ClientSession): Promise<Map<string, StudentLabel>> {
  const ids = [...new Set(studentIds)];
  if (ids.length === 0) return new Map();
  const students = await Student.find({ tenantId: f.tenantId, _id: { $in: ids } }).session(db ?? null).select('personId').lean<{ _id: string; personId: string }[]>();
  const [people, admissions] = await Promise.all([
    Person.find({ tenantId: f.tenantId, _id: { $in: students.map((s) => s.personId) } }).session(db ?? null).select('legalFirstName legalLastName preferredName').lean<{ _id: string; legalFirstName: string; legalLastName: string; preferredName: string | null }[]>(),
    StudentAdmission.find({ tenantId: f.tenantId, studentId: { $in: ids }, isCurrent: true }).session(db ?? null).select('studentId admissionNumber').lean<{ studentId: string; admissionNumber: string }[]>(),
  ]);
  const person = new Map(people.map((p) => [p._id, p]));
  const admission = new Map(admissions.map((a) => [a.studentId, a.admissionNumber]));
  return new Map(
    students.map((s) => {
      const p = person.get(s.personId);
      return [s._id, { studentId: s._id, personId: s.personId, name: p ? p.preferredName || `${p.legalFirstName} ${p.legalLastName}`.trim() : 'Student', admissionNumber: admission.get(s._id) ?? null }];
    }),
  );
}
