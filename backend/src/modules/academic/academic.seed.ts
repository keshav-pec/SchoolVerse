import {
  cloneSessionSchema,
  createChoiceGroupSchema,
  createClassOfferingsSchema,
  createProgrammeSchema,
  createSectionsSchema,
  createSessionSchema,
  createSubjectOfferingsSchema,
  createTermSchema,
  setBoardSubjectCodeSchema,
  type SubjectOfferingType,
} from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { cloneSession } from './clone.service';
import { changeSessionStatus } from './lifecycle.service';
import { createSubjectOfferings, createClassOfferings, createSections, listSubjectOfferings } from './offering.service';
import { createProgramme } from './programme.service';
import { BoardRuleVersion, EducationBoard, ClassMaster } from './reference.model';
import { createChoiceGroup } from './rules.service';
import { createSession } from './session.service';
import { Subject } from './subject.model';
import { setBoardSubjectCode } from './subject.service';
import { createTerm } from './term.service';
import { validateSession } from './validation.service';

/**
 * The PRD §23 dataset for Greenfield: session 2026-27 (ACTIVE) with Mohali on a national board template and Chandigarh on a
 * state board test template; Nursery–XII at Mohali and Nursery–VIII at Chandigarh; sections VIII-A/B/C; a Class VI language
 * choice group; Class XI programmes (Science, Commerce, Humanities, Flexible Combination); two terms. A DRAFT 2027-28 session
 * is then created by cloning, so the clone path can be demoed.
 *
 * Everything goes through the real services, so the data follows every rule and has an audit trail.
 */
const MOHALI_CLASSES = ['NURSERY', 'KG', ...Array.from({ length: 12 }, (_, i) => `G${String(i + 1).padStart(2, '0')}`)];
const CHANDIGARH_CLASSES = ['NURSERY', 'KG', ...Array.from({ length: 8 }, (_, i) => `G${String(i + 1).padStart(2, '0')}`)];

/** Official CBSE codes for a few subjects, so the board-code mapping is visible in the demo. */
const CBSE_CODES: Record<string, string> = {
  MATH: '041', PHY: '042', CHEM: '043', BIO: '044', ECO: '030', ACC: '055', BST: '054', HIST: '027', POLSC: '028', PSY: '037', CS: '083', PE: '048', SCI: '086', SST: '087',
};

type Plan = { code: string; type: SubjectOfferingType }[];
const plan = (codes: string, type: SubjectOfferingType = 'MANDATORY'): Plan => codes.split(' ').map((code) => ({ code, type }));

function subjectPlan(classCode: string): Plan {
  const n = Number(classCode.slice(1));
  if (classCode === 'NURSERY' || classCode === 'KG') return [...plan('ENG HIN'), ...plan('ART', 'SKILL')];
  if (n <= 5) return [...plan('ENG HIN MATH PE'), ...plan('ART', 'SKILL')];
  if (n <= 8) return [...plan('ENG HIN PUN URD', 'LANGUAGE'), ...plan('MATH SCI SST PE'), ...plan('ART', 'SKILL')];
  if (n <= 10) return [...plan('ENG HIN MATH SCI SST PE'), ...plan('CS', 'ELECTIVE')];
  return [...plan('ENG PE'), ...plan('MATH PHY CHEM BIO CS ECO ACC BST HIST POLSC PSY', 'ELECTIVE')];
}

export async function seedAcademicDemo(ctx: ServiceContext, locations: { mohaliId: string; chandigarhId: string }) {
  const [boards, versions, classes, subjects] = await Promise.all([
    EducationBoard.find({ tenantId: null, boardCode: { $in: ['CBSE', 'STATE_TEST'] } }).lean(),
    BoardRuleVersion.find({ tenantId: null, name: '2026-27' }).lean(),
    ClassMaster.find().lean(),
    Subject.find({ tenantId: ctx.tenantId }).lean(),
  ]);
  const board = (code: string) => boards.find((b) => b.boardCode === code)!;
  const version = (code: string) => versions.find((v) => v.boardId === board(code)._id)!;
  const classId = (code: string) => classes.find((g) => g.canonicalCode === code)!._id;
  const subjectId = (code: string) => subjects.find((s) => s.subjectCode === code)!._id;

  // Board codes first, so subject offerings pick them up on their own.
  for (const [code, boardSubjectCode] of Object.entries(CBSE_CODES)) {
    await setBoardSubjectCode(ctx, subjectId(code), setBoardSubjectCodeSchema.parse({ boardRuleVersionId: version('CBSE')._id, boardSubjectCode }));
  }

  const session = await createSession(
    ctx,
    createSessionSchema.parse({
      name: 'Academic Year 2026-27',
      code: '2026-27',
      startDate: '2026-04-01',
      endDate: '2027-03-31',
      locations: [
        { locationId: locations.mohaliId, boardId: board('CBSE')._id, boardRuleVersionId: version('CBSE')._id, affiliationNumber: '1630457' },
        { locationId: locations.chandigarhId, boardId: board('STATE_TEST')._id, boardRuleVersionId: version('STATE_TEST')._id },
      ],
    }),
  );
  const sessionId = session.academicSessionId;

  const setUp = async (locationId: string, classCodes: string[]) => {
    const offerings = await createClassOfferings(ctx, sessionId, createClassOfferingsSchema.parse({ locationId, classIds: classCodes.map(classId), medium: 'English' }));
    for (const offering of offerings) {
      const code = classes.find((g) => g._id === offering.classId)!.canonicalCode;
      await createSections(ctx, offering.classOfferingId, createSectionsSchema.parse({ codes: code === 'G08' ? ['A', 'B', 'C'] : ['A'] }));
      for (const type of ['MANDATORY', 'ELECTIVE', 'LANGUAGE', 'SKILL'] as const) {
        const ids = subjectPlan(code).filter((p) => p.type === type).map((p) => subjectId(p.code));
        if (ids.length) await createSubjectOfferings(ctx, offering.classOfferingId, createSubjectOfferingsSchema.parse({ subjectIds: ids, offeringType: type }));
      }
      if (code === 'G06') await seedLanguageGroups(offering.classOfferingId);
    }
    return offerings;
  };

  /** Class VI: a "Core" group, then Language 1 (Punjabi / Hindi / Urdu) and Language 2 — all data, no Punjab branch in the code. */
  const seedLanguageGroups = async (classOfferingId: string) => {
    const offerings = await listSubjectOfferings(ctx, classOfferingId);
    const idOf = (code: string) => offerings.find((o) => o.subjectCode === code)!.subjectOfferingId;
    const group = (name: string, ruleType: string, codes: string[]) =>
      createChoiceGroup(ctx, classOfferingId, createChoiceGroupSchema.parse({ name, ruleType, subjectOfferingIds: codes.map(idOf) }));
    await group('Core', 'REQUIRED_ALL', ['MATH', 'SCI', 'SST', 'PE']);
    await group('Language 1', 'CHOOSE_ONE', ['PUN', 'HIN', 'URD']);
    await group('Language 2', 'REQUIRED_ALL', ['ENG']);
  };

  const mohali = await setUp(locations.mohaliId, MOHALI_CLASSES);
  await setUp(locations.chandigarhId, CHANDIGARH_CLASSES);

  // Class XI programmes at Mohali.
  const class11 = mohali.find((o) => o.classId === classId('G11'))!;
  const g11 = await listSubjectOfferings(ctx, class11.classOfferingId);
  const rule = (code: string, requirement: 'REQUIRED' | 'CHOICE' | 'OPTIONAL') => ({ subjectOfferingId: g11.find((o) => o.subjectCode === code)!.subjectOfferingId, requirement });
  const programme = (code: string, name: string, kind: 'STREAM' | 'FLEXIBLE', subjectRules: ReturnType<typeof rule>[], extra: Record<string, unknown> = {}) =>
    createProgramme(
      ctx,
      createProgrammeSchema.parse({ academicSessionId: sessionId, locationId: locations.mohaliId, code, name, kind, classFromId: classId('G11'), classToId: classId('G11'), subjectRules, ...extra }),
    );
  await programme('SCI', 'Science', 'STREAM', [rule('ENG', 'REQUIRED'), rule('PHY', 'REQUIRED'), rule('CHEM', 'REQUIRED'), rule('MATH', 'CHOICE'), rule('BIO', 'CHOICE'), rule('CS', 'CHOICE')], { choiceMin: 1, choiceMax: 2 });
  await programme('COM', 'Commerce', 'STREAM', [rule('ENG', 'REQUIRED'), rule('ACC', 'REQUIRED'), rule('BST', 'REQUIRED'), rule('ECO', 'REQUIRED'), rule('MATH', 'OPTIONAL')]);
  await programme('HUM', 'Humanities', 'STREAM', [rule('ENG', 'REQUIRED'), rule('HIST', 'REQUIRED'), rule('POLSC', 'REQUIRED'), rule('ECO', 'CHOICE'), rule('PSY', 'CHOICE')], { choiceMin: 1, choiceMax: 1 });
  await programme('FLEX', 'Flexible Combination', 'FLEXIBLE', []);

  // Two session-wide terms.
  await createTerm(ctx, sessionId, createTermSchema.parse({ name: 'Term 1', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }));
  await createTerm(ctx, sessionId, createTermSchema.parse({ name: 'Term 2', code: 'T2', startDate: '2026-10-01', endDate: '2027-03-31' }));

  const result = await validateSession(ctx, sessionId);
  if (!result.canPublish) throw new Error(`Seed session failed validation: ${result.issues.filter((i) => i.level === 'ERROR').map((i) => i.message).join(' | ')}`);
  await changeSessionStatus(ctx, sessionId, 'publish');
  await changeSessionStatus(ctx, sessionId, 'activate');

  const next = await cloneSession(ctx, sessionId, cloneSessionSchema.parse({ name: 'Academic Year 2027-28', code: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31' }));
  return { sessionId, nextSessionId: next.academicSessionId };
}
