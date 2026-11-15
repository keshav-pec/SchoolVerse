import type { ClientSession } from 'mongoose';
import { AcademicProgramme, SubjectChoiceConstraint, SubjectChoiceGroup } from './rules.model';

/**
 * Removes the rules that point at deleted offerings. Hard deletes only happen in DRAFT sessions,
 * so nothing downstream can depend on these rows.
 */
export async function removeRulesForSubjectOfferings(tenantId: string, subjectOfferingIds: string[], db: ClientSession) {
  if (subjectOfferingIds.length === 0) return;
  await Promise.all([
    SubjectChoiceGroup.updateMany({ tenantId, subjectOfferingIds: { $in: subjectOfferingIds } }, { $pull: { subjectOfferingIds: { $in: subjectOfferingIds } } }, { session: db }),
    SubjectChoiceConstraint.deleteMany(
      { tenantId, $or: [{ subjectOfferingId: { $in: subjectOfferingIds } }, { otherSubjectOfferingId: { $in: subjectOfferingIds } }] },
      { session: db },
    ),
    AcademicProgramme.updateMany(
      { tenantId, 'subjectRules.subjectOfferingId': { $in: subjectOfferingIds } },
      { $pull: { subjectRules: { subjectOfferingId: { $in: subjectOfferingIds } } } },
      { session: db },
    ),
  ]);
  // A group left with no subjects has no meaning.
  await SubjectChoiceGroup.deleteMany({ tenantId, subjectOfferingIds: { $size: 0 } }, { session: db });
}

export async function removeRulesForGradeOffering(tenantId: string, gradeOfferingId: string, db: ClientSession) {
  const [groups, constraints] = await Promise.all([
    SubjectChoiceGroup.deleteMany({ tenantId, gradeOfferingId }, { session: db }),
    SubjectChoiceConstraint.deleteMany({ tenantId, gradeOfferingId }, { session: db }),
  ]);
  return { choiceGroups: groups.deletedCount, constraints: constraints.deletedCount };
}

export async function removeRulesForSession(tenantId: string, sessionId: string, db: ClientSession) {
  const [groups, constraints, programmes] = await Promise.all([
    SubjectChoiceGroup.deleteMany({ tenantId, sessionId }, { session: db }),
    SubjectChoiceConstraint.deleteMany({ tenantId, sessionId }, { session: db }),
    AcademicProgramme.deleteMany({ tenantId, sessionId }, { session: db }),
  ]);
  return { choiceGroups: groups.deletedCount, constraints: constraints.deletedCount, programmes: programmes.deletedCount };
}
