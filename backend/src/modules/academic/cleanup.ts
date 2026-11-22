import type { ClientSession } from 'mongoose';
import { AcademicProgramme, SubjectChoiceConstraint, SubjectChoiceGroup } from './rules.model';

/**
 * Other modules that keep rows about sections (Home Classroom assignments) register here, so a DRAFT session, class or section that is
 * deleted does not leave their rows behind. Hard deletes only happen in DRAFT sessions, before anything downstream is real.
 */
export interface OfferingCleanupScope {
  sessionId?: string;
  sectionOfferingIds?: string[];
}
type OfferingCleanup = (tenantId: string, scope: OfferingCleanupScope, db: ClientSession) => Promise<void>;
const offeringCleanups = new Map<string, OfferingCleanup>();

export function registerOfferingCleanup(key: string, cleanup: OfferingCleanup) {
  offeringCleanups.set(key, cleanup);
}

export async function runOfferingCleanup(tenantId: string, scope: OfferingCleanupScope, db: ClientSession) {
  for (const cleanup of offeringCleanups.values()) await cleanup(tenantId, scope, db);
}

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

export async function removeRulesForClassOffering(tenantId: string, classOfferingId: string, db: ClientSession) {
  const [groups, constraints] = await Promise.all([
    SubjectChoiceGroup.deleteMany({ tenantId, classOfferingId }, { session: db }),
    SubjectChoiceConstraint.deleteMany({ tenantId, classOfferingId }, { session: db }),
  ]);
  return { choiceGroups: groups.deletedCount, constraints: constraints.deletedCount };
}

export async function removeRulesForSession(tenantId: string, sessionId: string, db: ClientSession) {
  await runOfferingCleanup(tenantId, { sessionId }, db);
  const [groups, constraints, programmes] = await Promise.all([
    SubjectChoiceGroup.deleteMany({ tenantId, sessionId }, { session: db }),
    SubjectChoiceConstraint.deleteMany({ tenantId, sessionId }, { session: db }),
    AcademicProgramme.deleteMany({ tenantId, sessionId }, { session: db }),
  ]);
  return { choiceGroups: groups.deletedCount, constraints: constraints.deletedCount, programmes: programmes.deletedCount };
}
