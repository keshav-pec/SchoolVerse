import { randomUUID } from 'node:crypto';
import { createSubjectSchema, type BoardType, type EducationStage, type SubjectCategory } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { BoardRuleVersion, EducationBoard, ClassMaster } from './reference.model';
import { Subject } from './subject.model';
import { createSubject } from './subject.service';

/**
 * System reference data (Module 2): the 15-class master, the built-in boards and one `2026-27` rule version for each.
 * Idempotent (upserts by code), so it is safe to run on every seed and in tests.
 */

const CLASSES: { code: string; name: string; short: string; stage: EducationStage }[] = [
  { code: 'PRE_NURSERY', name: 'Pre-Nursery', short: 'PN', stage: 'FOUNDATIONAL' },
  { code: 'NURSERY', name: 'Nursery', short: 'N', stage: 'FOUNDATIONAL' },
  { code: 'KG', name: 'KG', short: 'KG', stage: 'FOUNDATIONAL' },
  ...Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    const stage: EducationStage = n <= 2 ? 'FOUNDATIONAL' : n <= 5 ? 'PREPARATORY' : n <= 8 ? 'MIDDLE' : 'SECONDARY';
    return { code: `G${String(n).padStart(2, '0')}`, name: `Class ${n}`, short: String(n), stage };
  }),
];

const BOARDS: { code: string; name: string; type: BoardType; stateCode: string | null }[] = [
  { code: 'CBSE', name: 'Central Board of Secondary Education', type: 'CENTRAL', stateCode: null },
  { code: 'CISCE', name: 'Council for the Indian School Certificate Examinations', type: 'CENTRAL', stateCode: null },
  { code: 'PSEB', name: 'Punjab School Education Board', type: 'STATE', stateCode: 'PB' },
  { code: 'STATE_TEST', name: 'State Board (test template)', type: 'STATE', stateCode: null },
  { code: 'CUSTOM', name: 'Custom', type: 'OTHER', stateCode: null },
];

export const SYSTEM_RULE_VERSION_NAME = '2026-27';

export async function seedReferenceData() {
  for (const [index, g] of CLASSES.entries()) {
    await ClassMaster.updateOne(
      { canonicalCode: g.code },
      {
        $set: {
          canonicalName: g.name,
          shortCode: g.short,
          sequenceNumber: index + 1,
          educationStage: g.stage,
          isPrePrimary: index < 3,
          isBoardClass: g.code === 'G10' || g.code === 'G12',
        },
        $setOnInsert: { _id: randomUUID() },
      },
      { upsert: true },
    );
  }

  for (const b of BOARDS) {
    await EducationBoard.updateOne(
      { tenantId: null, boardCode: b.code },
      { $set: { boardName: b.name, boardType: b.type, stateCode: b.stateCode, status: 'ACTIVE' }, $setOnInsert: { _id: randomUUID() } },
      { upsert: true },
    );
    const board = await EducationBoard.findOne({ tenantId: null, boardCode: b.code }).select('_id').lean<{ _id: string }>();
    await BoardRuleVersion.updateOne(
      { boardId: board!._id, name: SYSTEM_RULE_VERSION_NAME },
      {
        $set: { tenantId: null, effectiveFrom: '2026-04-01', effectiveTo: '2027-03-31', status: 'PUBLISHED', sourceReference: 'Built-in starter template' },
        $setOnInsert: { _id: randomUUID() },
      },
      { upsert: true },
    );
  }
}

const STARTER_SUBJECTS: { code: string; name: string; category: SubjectCategory; language?: string; practical?: boolean; internal?: boolean }[] = [
  { code: 'ENG', name: 'English', category: 'LANGUAGE', language: 'en' },
  { code: 'HIN', name: 'Hindi', category: 'LANGUAGE', language: 'hi' },
  { code: 'PUN', name: 'Punjabi', category: 'LANGUAGE', language: 'pa' },
  { code: 'URD', name: 'Urdu', category: 'LANGUAGE', language: 'ur' },
  { code: 'MATH', name: 'Mathematics', category: 'MATHEMATICS' },
  { code: 'SCI', name: 'Science', category: 'SCIENCE', practical: true },
  { code: 'SST', name: 'Social Science', category: 'SOCIAL_SCIENCE' },
  { code: 'PHY', name: 'Physics', category: 'SCIENCE', practical: true },
  { code: 'CHEM', name: 'Chemistry', category: 'SCIENCE', practical: true },
  { code: 'BIO', name: 'Biology', category: 'SCIENCE', practical: true },
  { code: 'CS', name: 'Computer Science', category: 'TECHNOLOGY', practical: true },
  { code: 'ECO', name: 'Economics', category: 'COMMERCE' },
  { code: 'ACC', name: 'Accountancy', category: 'COMMERCE' },
  { code: 'BST', name: 'Business Studies', category: 'COMMERCE' },
  { code: 'HIST', name: 'History', category: 'HUMANITIES' },
  { code: 'POLSC', name: 'Political Science', category: 'HUMANITIES' },
  { code: 'PSY', name: 'Psychology', category: 'HUMANITIES' },
  { code: 'PE', name: 'Physical Education', category: 'PHYSICAL_EDUCATION', internal: true },
  { code: 'ART', name: 'Art', category: 'ARTS', internal: true },
  { code: 'WE', name: 'Work Education', category: 'SKILL', internal: true },
];

/** The starter subject list from the PRD, created through the real service (so it is audited). Skips codes that exist. */
export async function seedStarterSubjects(ctx: ServiceContext) {
  const have = new Set((await Subject.find({ tenantId: ctx.tenantId }).select('subjectCode').lean<{ subjectCode: string }[]>()).map((s) => s.subjectCode));
  const created = [];
  for (const s of STARTER_SUBJECTS) {
    if (have.has(s.code)) continue;
    created.push(
      await createSubject(
        ctx,
        createSubjectSchema.parse({
          subjectCode: s.code,
          name: s.name,
          category: s.category,
          languageCode: s.language ?? null,
          hasPractical: s.practical ?? false,
          hasInternalAssessment: s.internal ?? false,
        }),
      ),
    );
  }
  return created;
}
