import type { ParentChildDTO, ParentChildrenDTO, ParentStudentSummaryDTO } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { labelsFor } from '../staff/location-assignment.service';
import { todayFor } from '../staff/status';
import { displayNameOf, fullNameOf, hydrateStudents } from './directory';
import { loadStudent } from './guards';
import { toDirectoryDTO } from './mappers';
import { assertParentCanAccess, assertParentRole, parentLinksFor } from './parent-access';
import { liveSubjectRows, toSubjectDTOs } from './subject.service';
import { Student, type StudentDoc } from './student.models';

/**
 * SPM-12 — the parent portal's reads. Every call starts from the parent's own guardian links, checked in the database; a child
 * id that comes from the browser is only ever looked up among those links (`assertParentCanAccess`).
 */

/** The children this login may see: the child switcher. */
export async function listChildren(ctx: ServiceContext): Promise<ParentChildrenDTO> {
  assertParentRole(ctx);
  const found = await parentLinksFor(ctx, null);
  if (!found || found.links.length === 0) return { children: [] };
  const byStudent = new Map<string, (typeof found.links)[number]>();
  for (const l of found.links) if (l.canSeeAcademics || l.canSeeFees) byStudent.set(l.studentId, l);
  const students = await Student.find({ tenantId: ctx.tenantId, _id: { $in: [...byStudent.keys()] } }).lean<StudentDoc[]>();
  const h = await hydrateStudents(ctx, students);
  const children: ParentChildDTO[] = students
    .map((s) => {
      const dir = toDirectoryDTO(s, h);
      const link = byStudent.get(s._id)!;
      return {
        studentId: s._id,
        fullName: dir.fullName,
        displayName: dir.displayName,
        admissionNumber: dir.admissionNumber,
        classSection: dir.classSection,
        status: s.status,
        relationshipType: link.relationshipType,
        canSeeAcademics: link.canSeeAcademics,
        canSeeFees: link.canSeeFees,
      };
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' }));
  return { children };
}

/** One child, as a parent sees them. Name, class, roll, subjects and the primary parent's name; nothing else. */
export async function getChild(ctx: ServiceContext, studentId: string): Promise<ParentStudentSummaryDTO> {
  assertParentRole(ctx);
  await assertParentCanAccess(ctx, studentId, 'ACADEMICS');
  const student = await loadStudent(ctx, studentId);
  const today = await todayFor(ctx);
  const h = await hydrateStudents(ctx, [student], { today });
  const placement = h.placements.get(studentId);
  const person = h.people.get(student.personId)!;
  const dir = toDirectoryDTO(student, h);

  const rows = placement?.enrollment ? await liveSubjectRows(ctx, placement.enrollment._id, today) : [];
  const subjects = (await toSubjectDTOs(ctx, rows, today)).map((s) => ({ subjectOfferingId: s.subjectOfferingId, subjectName: s.subjectName, isMandatory: s.isMandatory }));
  const locations = placement?.enrollment ? await labelsFor(ctx.tenantId, [placement.enrollment.locationId]) : null;
  return {
    studentId,
    fullName: fullNameOf(person),
    displayName: displayNameOf(person),
    admissionNumber: dir.admissionNumber,
    classSection: dir.classSection,
    rollNumber: dir.rollNumber,
    hasPhoto: Boolean(student.photoKey),
    subjects: subjects.sort((a, b) => Number(b.isMandatory) - Number(a.isMandatory) || a.subjectName.localeCompare(b.subjectName)),
    primaryGuardianName: dir.primaryGuardianName,
    campusName: locations?.get(placement!.enrollment!.locationId)?.displayName ?? null,
  };
}
