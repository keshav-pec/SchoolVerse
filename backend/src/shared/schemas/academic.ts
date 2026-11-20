import { z } from 'zod';
import {
  BOARD_TYPES,
  CHOICE_RULE_TYPES,
  CONSTRAINT_TYPES,
  OFFERING_STATUSES,
  PROGRAMME_KINDS,
  PROGRAMME_REQUIREMENTS,
  SESSION_STATUSES,
  SUBJECT_CATEGORIES,
  SUBJECT_OFFERING_TYPES,
  SUBJECT_STATUSES,
  TERM_TYPES,
} from '../enums';
import { uuidSchema } from './common';
import { optionalText, requiredDateSchema, requiredText } from './fields';

/**
 * Academic structure contracts (Module 2). Optional text accepts `""`/`null` (stored as `null`);
 * on PATCH a missing key means "leave unchanged".
 */

const emptyToNull = (v: unknown) => (v === null || (typeof v === 'string' && v.trim() === '') ? null : v);

function optionalInt(label: string, min: number, max: number) {
  return z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : emptyToNull(v)),
    z
      .number({ message: `${label} must be a number.` })
      .int({ message: `${label} must be a whole number.` })
      .min(min, { message: `${label} must be at least ${min}.` })
      .max(max, { message: `${label} must be at most ${max}.` })
      .nullable(),
  ).optional();
}

const uuidList = (label: string, max = 50) =>
  z
    .array(uuidSchema, { message: `${label} is required.` })
    .min(1, { message: `Choose at least one.` })
    .max(max, { message: `Choose at most ${max} at a time.` });

// ───────────────────────────────────────────────────────────── codes

export const BOARD_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;
export const SUBJECT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;
export const SESSION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
export const SECTION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,9}$/;
export const TERM_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;

const upperCode = (label: string, pattern: RegExp, hint: string) =>
  z
    .string({ message: `${label} is required.` })
    .transform((v) => v.trim().toUpperCase())
    .pipe(z.string().min(1, { message: `${label} is required.` }).regex(pattern, { message: hint }));

export const boardCodeSchema = upperCode('Board code', BOARD_CODE_PATTERN, 'Use 2–20 letters, numbers, hyphens or underscores, e.g. CBSE.');
export const subjectCodeSchema = upperCode('Subject code', SUBJECT_CODE_PATTERN, 'Use 2–20 letters, numbers, hyphens or underscores, e.g. MATH.');
export const sessionCodeSchema = upperCode('Session code', SESSION_CODE_PATTERN, 'Use 2–20 letters, numbers or hyphens, e.g. 2026-27.');
export const sectionCodeSchema = upperCode('Section code', SECTION_CODE_PATTERN, 'Use 1–10 letters, numbers or hyphens, e.g. A or ROSE.');
export const termCodeSchema = upperCode('Term code', TERM_CODE_PATTERN, 'Use up to 20 letters, numbers, hyphens or underscores, e.g. T1.');

// ───────────────────────────────────────────────────────────── boards & rule versions

export const createBoardSchema = z.object({
  boardCode: boardCodeSchema,
  boardName: requiredText('Board name', 120),
  boardType: z.enum(BOARD_TYPES, { message: 'Choose a board type.' }).default('OTHER'),
  stateCode: optionalText(10),
});
export type CreateBoardData = z.output<typeof createBoardSchema>;

export const createRuleVersionSchema = z
  .object({
    name: requiredText('Version name', 60),
    effectiveFrom: z.preprocess(emptyToNull, requiredDateSchema.nullable()).optional(),
    effectiveTo: z.preprocess(emptyToNull, requiredDateSchema.nullable()).optional(),
    sourceReference: optionalText(300),
  })
  .refine((v) => !v.effectiveFrom || !v.effectiveTo || v.effectiveFrom <= v.effectiveTo, {
    path: ['effectiveTo'],
    message: 'The end date cannot be before the start date.',
  });
export type CreateRuleVersionData = z.output<typeof createRuleVersionSchema>;

// ───────────────────────────────────────────────────────────── subjects

const subjectShape = {
  subjectCode: subjectCodeSchema,
  name: requiredText('Subject name', 100),
  shortName: optionalText(30),
  category: z.enum(SUBJECT_CATEGORIES, { message: 'Choose a category.' }),
  languageCode: optionalText(10),
  hasTheory: z.boolean().optional(),
  hasPractical: z.boolean().optional(),
  hasProject: z.boolean().optional(),
  hasInternalAssessment: z.boolean().optional(),
};

export const SUBJECT_EDITABLE_FIELDS = [
  'subjectCode',
  'name',
  'shortName',
  'category',
  'languageCode',
  'hasTheory',
  'hasPractical',
  'hasProject',
  'hasInternalAssessment',
  'status',
] as const;

export const createSubjectSchema = z.object(subjectShape);
export type CreateSubjectData = z.output<typeof createSubjectSchema>;

export const updateSubjectSchema = z
  .object({ ...subjectShape, status: z.enum(SUBJECT_STATUSES, { message: 'Choose a valid status.' }) })
  .partial();
export type UpdateSubjectData = z.output<typeof updateSubjectSchema>;

const optionalFilter = z.preprocess(emptyToNull, z.string().trim().max(100).nullable()).optional().transform((v) => v ?? undefined);

export const listSubjectsQuerySchema = z.object({
  search: optionalFilter,
  category: z.enum(SUBJECT_CATEGORIES).optional(),
  languageCode: optionalFilter,
  status: z.enum(SUBJECT_STATUSES).optional(),
  /** Official board subject code (e.g. `041`) or a board code (e.g. `CBSE`). */
  boardCode: optionalFilter,
  /** Subjects offered for this master class in any session (narrow with `academicSessionId`). */
  classId: uuidSchema.optional(),
  academicSessionId: uuidSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListSubjectsQuery = z.output<typeof listSubjectsQuerySchema>;

export const setBoardSubjectCodeSchema = z.object({
  boardRuleVersionId: uuidSchema,
  boardSubjectCode: requiredText('Board subject code', 30),
  boardSubjectName: optionalText(120),
});
export type SetBoardSubjectCodeData = z.output<typeof setBoardSubjectCodeSchema>;

// ───────────────────────────────────────────────────────────── academic sessions

export const sessionLocationSchema = z.object({
  locationId: uuidSchema,
  boardId: uuidSchema,
  boardRuleVersionId: uuidSchema,
  affiliationNumber: optionalText(50),
});
export type SessionLocationInput = z.output<typeof sessionLocationSchema>;

export const SESSION_EDITABLE_FIELDS = ['name', 'startDate', 'endDate', 'locations'] as const;

const sessionShape = {
  name: requiredText('Session name', 100),
  startDate: requiredDateSchema,
  endDate: requiredDateSchema,
  locations: z.array(sessionLocationSchema).max(50, { message: 'Too many locations.' }),
};

export const createSessionSchema = z.object({
  ...sessionShape,
  code: sessionCodeSchema,
  locations: sessionShape.locations.default([]),
});
export type CreateSessionData = z.output<typeof createSessionSchema>;

export const updateSessionSchema = z.object(sessionShape).partial();
export type UpdateSessionData = z.output<typeof updateSessionSchema>;

export const listSessionsQuerySchema = z.object({ status: z.enum(SESSION_STATUSES).optional() });
export type ListSessionsQuery = z.output<typeof listSessionsQuerySchema>;

// ───────────────────────────────────────────────────────────── class offerings & sections

export const createClassOfferingsSchema = z.object({
  locationId: uuidSchema,
  classIds: uuidList('Classes', 20),
  medium: optionalText(50),
  /** Optional school-specific names, keyed by class id (e.g. "KG" → "Playgroup"). Classes left out keep the standard name. */
  labels: z.record(uuidSchema, z.object({ displayName: requiredText('Display name', 60), displayCode: requiredText('Display code', 20) })).optional(),
});
export type CreateClassOfferingsData = z.output<typeof createClassOfferingsSchema>;

export const CLASS_OFFERING_EDITABLE_FIELDS = ['displayName', 'displayCode', 'medium', 'capacity', 'sequenceOrder', 'status'] as const;

export const updateClassOfferingSchema = z
  .object({
    displayName: requiredText('Display name', 60),
    displayCode: requiredText('Display code', 20),
    medium: optionalText(50),
    capacity: optionalInt('Capacity', 1, 100000),
    sequenceOrder: z.coerce.number().int().min(0).max(1000),
    status: z.enum(OFFERING_STATUSES, { message: 'Choose a valid status.' }),
  })
  .partial();
export type UpdateClassOfferingData = z.output<typeof updateClassOfferingSchema>;

export const createSectionsSchema = z.object({
  codes: z
    .array(sectionCodeSchema, { message: 'Enter at least one section code.' })
    .min(1, { message: 'Enter at least one section code.' })
    .max(26, { message: 'Add at most 26 sections at a time.' }),
  capacity: optionalInt('Capacity', 1, 10000),
});
export type CreateSectionsData = z.output<typeof createSectionsSchema>;

/** Gives every class at one location the same sections in one go. Codes a class already has are skipped. */
export const applySectionsToAllSchema = createSectionsSchema.extend({ locationId: uuidSchema });
export type ApplySectionsToAllData = z.output<typeof applySectionsToAllSchema>;

export const SECTION_EDITABLE_FIELDS = ['displayName', 'capacity', 'sequenceOrder', 'status'] as const;

export const updateSectionSchema = z
  .object({
    displayName: requiredText('Display name', 60),
    capacity: optionalInt('Capacity', 1, 10000),
    sequenceOrder: z.coerce.number().int().min(0).max(1000),
    status: z.enum(OFFERING_STATUSES, { message: 'Choose a valid status.' }),
  })
  .partial();
export type UpdateSectionData = z.output<typeof updateSectionSchema>;

// ───────────────────────────────────────────────────────────── subject offerings

export const createSubjectOfferingsSchema = z.object({
  subjectIds: uuidList('Subjects', 50),
  offeringType: z.enum(SUBJECT_OFFERING_TYPES, { message: 'Choose an offering type.' }),
});
export type CreateSubjectOfferingsData = z.output<typeof createSubjectOfferingsSchema>;

export const SUBJECT_OFFERING_EDITABLE_FIELDS = ['offeringType', 'boardSubjectDefinitionId', 'status'] as const;

export const updateSubjectOfferingSchema = z
  .object({
    offeringType: z.enum(SUBJECT_OFFERING_TYPES, { message: 'Choose an offering type.' }),
    boardSubjectDefinitionId: z.preprocess(emptyToNull, uuidSchema.nullable()),
    status: z.enum(OFFERING_STATUSES, { message: 'Choose a valid status.' }),
  })
  .partial();
export type UpdateSubjectOfferingData = z.output<typeof updateSubjectOfferingSchema>;

// ───────────────────────────────────────────────────────────── terms

export const TERM_EDITABLE_FIELDS = ['locationId', 'name', 'code', 'type', 'sequence', 'startDate', 'endDate'] as const;

const termShape = {
  locationId: z.preprocess(emptyToNull, uuidSchema.nullable()),
  name: requiredText('Term name', 100),
  code: termCodeSchema,
  type: z.enum(TERM_TYPES, { message: 'Choose a term type.' }),
  sequence: z.coerce.number().int().min(1).max(20),
  startDate: requiredDateSchema,
  endDate: requiredDateSchema,
};

export const createTermSchema = z.object({
  ...termShape,
  type: termShape.type.default('TERM'),
  locationId: termShape.locationId.optional(),
  sequence: termShape.sequence.optional(),
});
export type CreateTermData = z.output<typeof createTermSchema>;

export const updateTermSchema = z.object(termShape).partial();
export type UpdateTermData = z.output<typeof updateTermSchema>;

// ───────────────────────────────────────────────────────────── choice groups & constraints (AS-08, AS-09)

export const CHOICE_GROUP_EDITABLE_FIELDS = ['name', 'ruleType', 'min', 'max', 'sequence', 'subjectOfferingIds', 'status'] as const;

const choiceGroupShape = {
  name: requiredText('Group name', 80),
  ruleType: z.enum(CHOICE_RULE_TYPES, { message: 'Choose a rule type.' }),
  /** CHOOSE_N: lowest number of subjects a student takes. Ignored for the other types (they are derived). */
  min: optionalInt('Minimum', 0, 50),
  /** CHOOSE_N / OPTIONAL: highest number of subjects a student takes. */
  max: optionalInt('Maximum', 1, 50),
  sequence: optionalInt('Order', 0, 1000),
  subjectOfferingIds: uuidList('Subjects', 50),
};

export const createChoiceGroupSchema = z.object(choiceGroupShape);
export type CreateChoiceGroupData = z.output<typeof createChoiceGroupSchema>;

export const updateChoiceGroupSchema = z
  .object({ ...choiceGroupShape, status: z.enum(OFFERING_STATUSES, { message: 'Choose a valid status.' }) })
  .partial();
export type UpdateChoiceGroupData = z.output<typeof updateChoiceGroupSchema>;

export const createConstraintSchema = z.object({
  type: z.enum(CONSTRAINT_TYPES, { message: 'Choose REQUIRES or EXCLUDES.' }),
  subjectOfferingId: uuidSchema,
  otherSubjectOfferingId: uuidSchema,
});
export type CreateConstraintData = z.output<typeof createConstraintSchema>;

// ───────────────────────────────────────────────────────────── programmes (AS-10, AS-11)

export const PROGRAMME_EDITABLE_FIELDS = ['name', 'kind', 'classFromId', 'classToId', 'boardId', 'subjectRules', 'choiceMin', 'choiceMax', 'status'] as const;

export const programmeSubjectRuleSchema = z.object({
  subjectOfferingId: uuidSchema,
  requirement: z.enum(PROGRAMME_REQUIREMENTS, { message: 'Choose REQUIRED, CHOICE or OPTIONAL.' }),
});

const programmeShape = {
  name: requiredText('Programme name', 80),
  kind: z.enum(PROGRAMME_KINDS, { message: 'Choose STREAM or FLEXIBLE.' }),
  classFromId: uuidSchema,
  classToId: uuidSchema,
  boardId: z.preprocess(emptyToNull, uuidSchema.nullable()),
  subjectRules: z.array(programmeSubjectRuleSchema).max(60, { message: 'Too many subjects.' }),
  choiceMin: optionalInt('Minimum choices', 0, 50),
  choiceMax: optionalInt('Maximum choices', 0, 50),
};

export const createProgrammeSchema = z.object({
  academicSessionId: uuidSchema,
  locationId: uuidSchema,
  code: upperCode('Programme code', TERM_CODE_PATTERN, 'Use up to 20 letters, numbers, hyphens or underscores, e.g. SCI.'),
  ...programmeShape,
  boardId: programmeShape.boardId.optional(),
  subjectRules: programmeShape.subjectRules.default([]),
});
export type CreateProgrammeData = z.output<typeof createProgrammeSchema>;

export const updateProgrammeSchema = z
  .object({ ...programmeShape, status: z.enum(OFFERING_STATUSES, { message: 'Choose a valid status.' }) })
  .partial();
export type UpdateProgrammeData = z.output<typeof updateProgrammeSchema>;

export const listProgrammesQuerySchema = z.object({ academicSessionId: uuidSchema, locationId: uuidSchema.optional() });
export type ListProgrammesQuery = z.output<typeof listProgrammesQuerySchema>;

// ───────────────────────────────────────────────────────────── clone & context

export const cloneSessionSchema = z.object({
  name: requiredText('Session name', 100),
  code: sessionCodeSchema,
  startDate: requiredDateSchema,
  endDate: requiredDateSchema,
});
export type CloneSessionData = z.output<typeof cloneSessionSchema>;

export const academicContextQuerySchema = z.object({
  academicSessionId: uuidSchema,
  locationId: uuidSchema,
  /** Master class id. Omit it to list the classes offered at the location. */
  classId: uuidSchema.optional(),
});
export type AcademicContextQuery = z.output<typeof academicContextQuerySchema>;
