import type { AssignmentStatus, ChoiceRuleType, EnrollmentState, EnrollmentStatus, ProgrammeKind, ProgrammeRequirement, PromotionReviewReason, StudentStatus, SubjectOfferingType, SubjectProblemDTO, SubjectSelectionResultDTO } from '@shared';
import { describeGroup } from '../academic/rules.service';

/**
 * Pure rules for Module 4 (no database), so they can be unit-tested and reused by Part 3 (promotion, import).
 */

// ───────────────────────────────────────────────────────────── admission number

export interface AdmissionNumberPattern {
  prefix: string;
  includeLocationCode: boolean;
  includeYear: boolean;
  padding: number;
}

/** `GPS/MOH/2027/00482`: prefix, location code, year, then the padded counter. Empty parts are left out. */
export function formatAdmissionNumber(pattern: AdmissionNumberPattern, parts: { locationCode: string | null; year: number | null; sequence: number }): string {
  return [
    pattern.prefix.trim(),
    pattern.includeLocationCode ? parts.locationCode ?? '' : '',
    pattern.includeYear && parts.year ? String(parts.year) : '',
    String(parts.sequence).padStart(pattern.padding, '0'),
  ]
    .filter(Boolean)
    .join('/')
    .toUpperCase();
}

// ───────────────────────────────────────────────────────────── roll numbers

/** The next free roll number: one more than the highest number in use (letters-only rolls are ignored). */
export function nextFreeRoll(taken: readonly (string | null)[]): string {
  const used = new Set(taken.filter((r): r is string => Boolean(r)));
  let n = [...used].reduce((max, r) => (/^\d+$/.test(r) ? Math.max(max, Number(r)) : max), 0) + 1;
  while (used.has(String(n))) n += 1;
  return String(n);
}

/** Numbers sort numerically inside text ("A-2" before "A-10"). */
export const naturalCompare = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

// ───────────────────────────────────────────────────────────── names

/** Lower-case words, no punctuation, in alphabetical order, so "Sharma Riya" and "Riya Sharma" are the same name. */
export function nameKey(...parts: (string | null | undefined)[]): string {
  return parts
    .join(' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** Almost the same, but not the same: one slip in a short name, two in a long one ("Simran" / "Simrann"). */
export function isSimilarName(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  const limit = Math.max(a.length, b.length) >= 12 ? 2 : 1;
  return editDistance(a, b) <= limit;
}

// ───────────────────────────────────────────────────────────── computed statuses

/**
 * Shown status of an enrollment: stored `state`, except an OPEN one is PLANNED before it starts and ACTIVE after.
 * An OPEN enrollment whose last day has passed is still shown as ACTIVE until someone completes it (promotion does).
 */
export function enrollmentStatus(row: { state: EnrollmentState; effectiveFrom: string }, today: string): EnrollmentStatus {
  if (row.state !== 'OPEN') return row.state;
  return today < row.effectiveFrom ? 'PLANNED' : 'ACTIVE';
}

/** Rows are open on a day when they started and have not ended or been cancelled. */
export function isOpenOn(row: { effectiveFrom: string; effectiveTo?: string | null; cancelledAt?: Date | string | null }, date: string): boolean {
  if (row.cancelledAt) return false;
  if (date < row.effectiveFrom) return false;
  return !row.effectiveTo || date <= row.effectiveTo;
}

export type RowStatus = AssignmentStatus;

// ───────────────────────────────────────────────────────────── subject choice check

export interface CheckOffering {
  id: string;
  name: string;
  type: SubjectOfferingType;
  active: boolean;
}

export interface CheckGroup {
  id: string;
  name: string;
  ruleType: ChoiceRuleType;
  min: number;
  max: number;
  subjectOfferingIds: string[];
  active: boolean;
}

export interface CheckConstraint {
  type: 'REQUIRES' | 'EXCLUDES';
  subjectOfferingId: string;
  otherSubjectOfferingId: string;
}

export interface CheckProgramme {
  name: string;
  kind: ProgrammeKind;
  subjectRules: { subjectOfferingId: string; requirement: ProgrammeRequirement }[];
  choiceMin: number | null;
  choiceMax: number | null;
}

export interface SubjectCheckInput {
  offerings: CheckOffering[];
  groups: CheckGroup[];
  constraints: CheckConstraint[];
  programme: CheckProgramme | null;
  selected: readonly string[];
  /**
   * `true` (saving a choice): the always-taken subjects are added to the selection, so the caller need not list them.
   * `false` (checking what a student takes today): a missing always-taken subject is a problem.
   */
  addMandatory: boolean;
}

/** Subjects every student of the class takes: MANDATORY offerings, and everything in a "take all" group. */
export function mandatoryOfferingIds(offerings: readonly CheckOffering[], groups: readonly CheckGroup[]): string[] {
  const active = new Set(offerings.filter((o) => o.active).map((o) => o.id));
  const ids = new Set(offerings.filter((o) => o.active && o.type === 'MANDATORY').map((o) => o.id));
  for (const g of groups) {
    if (g.active && g.ruleType === 'REQUIRED_ALL') for (const id of g.subjectOfferingIds) if (active.has(id)) ids.add(id);
  }
  return [...ids];
}

const list = (names: string[]) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * Checks a subject choice against the Module 2 rules and says, in plain words, what to fix:
 * choice groups (min / max / choose-one / choose-N), REQUIRES and EXCLUDES pairs, and the programme's own rules.
 */
export function checkSubjectSelection(input: SubjectCheckInput): SubjectSelectionResultDTO {
  const byId = new Map(input.offerings.map((o) => [o.id, o]));
  const nameOf = (id: string) => byId.get(id)?.name ?? 'This subject';
  const mandatory = mandatoryOfferingIds(input.offerings, input.groups);
  const problems: SubjectProblemDTO[] = [];

  const chosen = new Set<string>();
  for (const id of input.selected) {
    const offering = byId.get(id);
    if (!offering || !offering.active) {
      problems.push({ code: 'NOT_OFFERED', message: `${offering ? offering.name : 'One of the subjects'} is not offered in this class.`, subjectOfferingIds: [id] });
      continue;
    }
    chosen.add(id);
  }
  if (input.addMandatory) for (const id of mandatory) chosen.add(id);
  else {
    const missing = mandatory.filter((id) => !chosen.has(id));
    if (missing.length > 0) problems.push({ code: 'MISSING_MANDATORY', message: `Required: ${list(missing.map(nameOf))}.`, subjectOfferingIds: missing });
  }

  const groups = input.groups
    .filter((g) => g.active)
    .map((g) => {
      const picked = g.subjectOfferingIds.filter((id) => chosen.has(id));
      const names = g.subjectOfferingIds.map(nameOf);
      const satisfied = picked.length >= g.min && picked.length <= g.max;
      if (picked.length < g.min) {
        problems.push({
          code: 'GROUP_TOO_FEW',
          message: g.ruleType === 'REQUIRED_ALL' ? `Take all of ${list(names)}.` : `Pick ${g.min} from ${g.name}. You picked ${picked.length}.`,
          choiceGroupId: g.id,
          subjectOfferingIds: g.subjectOfferingIds,
        });
      } else if (picked.length > g.max) {
        problems.push({
          code: 'GROUP_TOO_MANY',
          message: g.max === 1 ? `Pick only 1 from ${g.name}. You picked ${picked.length}.` : `Pick at most ${g.max} from ${g.name}. You picked ${picked.length}.`,
          choiceGroupId: g.id,
          subjectOfferingIds: picked,
        });
      }
      return { choiceGroupId: g.id, name: g.name, ruleType: g.ruleType, min: g.min, max: g.max, summary: describeGroup(g.ruleType, g.min, g.max, names), picked: picked.length, satisfied };
    });

  for (const c of input.constraints) {
    const a = c.subjectOfferingId;
    const b = c.otherSubjectOfferingId;
    if (c.type === 'REQUIRES' && chosen.has(a) && !chosen.has(b)) {
      problems.push({ code: 'REQUIRES', message: `${nameOf(a)} needs ${nameOf(b)} too.`, subjectOfferingIds: [a, b] });
    }
    if (c.type === 'EXCLUDES' && chosen.has(a) && chosen.has(b)) {
      problems.push({ code: 'EXCLUDES', message: `${nameOf(a)} and ${nameOf(b)} cannot be taken together.`, subjectOfferingIds: [a, b] });
    }
  }

  const programme = input.programme;
  // A flexible combination has no fixed subject list of its own: the class's groups and rules above are what applies.
  if (programme && programme.kind === 'STREAM') {
    const ruleIds = new Set(programme.subjectRules.map((r) => r.subjectOfferingId));
    const missing = programme.subjectRules.filter((r) => r.requirement === 'REQUIRED' && !chosen.has(r.subjectOfferingId)).map((r) => r.subjectOfferingId);
    if (missing.length > 0) {
      problems.push({ code: 'PROGRAMME_REQUIRED', message: `${programme.name} needs ${list(missing.map(nameOf))}.`, subjectOfferingIds: missing });
    }
    const choices = programme.subjectRules.filter((r) => r.requirement === 'CHOICE').map((r) => r.subjectOfferingId);
    if (choices.length > 0) {
      const picked = choices.filter((id) => chosen.has(id));
      const min = programme.choiceMin ?? 1;
      const max = programme.choiceMax ?? min;
      if (picked.length < min) {
        problems.push({ code: 'PROGRAMME_CHOICE_TOO_FEW', message: `For ${programme.name}, pick ${min} from ${list(choices.map(nameOf))}. You picked ${picked.length}.`, subjectOfferingIds: choices });
      } else if (picked.length > max) {
        problems.push({ code: 'PROGRAMME_CHOICE_TOO_MANY', message: `For ${programme.name}, pick at most ${max} from ${list(choices.map(nameOf))}. You picked ${picked.length}.`, subjectOfferingIds: picked });
      }
    }
    const outside = [...chosen].filter((id) => !ruleIds.has(id) && !mandatory.includes(id));
    if (outside.length > 0) {
      problems.push({ code: 'NOT_IN_PROGRAMME', message: `${list(outside.map(nameOf))} ${outside.length === 1 ? 'is' : 'are'} not part of ${programme.name}.`, subjectOfferingIds: outside });
    }
  }

  return { valid: problems.length === 0, problems, groups, mandatoryOfferingIds: mandatory, selectedOfferingIds: [...chosen] };
}

/** Problems that are only "not chosen yet" (as opposed to a wrong choice): shown as "still undecided". */
export const UNDECIDED_CODES = ['GROUP_TOO_FEW', 'PROGRAMME_CHOICE_TOO_FEW'] as const;


// ───────────────────────────────────────────────────────────── promotion (Part 3)

export interface ClassLevel {
  classOfferingId: string;
  classId: string;
  /** Position in the class master: Class 5 is 5, Class 6 is 6… */
  sequenceNumber: number;
}

/** The standard next class: the offered class that comes straight after this one. No gaps are skipped (a missing class needs a person to decide). */
export function resolveNextClass(currentSequence: number, offered: readonly ClassLevel[]): ClassLevel | null {
  return offered.find((c) => c.sequenceNumber === currentSequence + 1) ?? null;
}

/** The school's last class at a location: nothing higher is offered in the session the student is leaving. */
export function isFinalClass(currentSequence: number, offeredSequencesInFromSession: readonly number[]): boolean {
  return !offeredSequencesInFromSession.some((n) => n > currentSequence);
}

export interface SectionLoad {
  sectionId: string;
  capacity: number | null;
  enrolled: number;
  sequenceOrder: number;
}

/** The section with the most room: sections that are not full first, then the fewest students, then the usual order. Balances strength as students are placed. */
export function pickSection(sections: readonly SectionLoad[]): SectionLoad | null {
  const open = sections.filter((s) => s.capacity === null || s.enrolled < s.capacity);
  const pool = open.length > 0 ? open : sections;
  return [...pool].sort((a, b) => a.enrolled - b.enrolled || a.sequenceOrder - b.sequenceOrder || a.sectionId.localeCompare(b.sectionId))[0] ?? null;
}

export const PROMOTION_REASON_TEXT: Record<PromotionReviewReason, string> = {
  NO_NEXT_CLASS: 'No class is offered for next year.',
  LEAVING: 'This student is leaving the school.',
  SUBJECT_CHOICE_PENDING: 'The subject choice is not complete.',
  PROGRAMME_NOT_VALID: 'Their programme is not available in the next class.',
  SECTION_MISSING: 'No section is set for this year.',
  LOCATION_MISSING: 'This campus is not part of the next session.',
  STUDENT_NOT_ACTIVE: 'This student is not active.',
  ALREADY_PROMOTED: 'Already has a place in the next session.',
};

export interface PromotionFacts {
  studentStatus: StudentStatus;
  hasSection: boolean;
  locationInTarget: boolean;
  nextClassFound: boolean;
  isFinal: boolean;
  subjectChoiceIncomplete: boolean;
  programmeOk: boolean;
  alreadyHasTargetEnrollment: boolean;
}

/** Why a student needs a look before promotion. No reasons means READY. Results and marks are not used: this module does not track them. */
export function promotionReviewReasons(f: PromotionFacts): PromotionReviewReason[] {
  const reasons: PromotionReviewReason[] = [];
  if (f.studentStatus === 'WITHDRAWAL_INITIATED') reasons.push('LEAVING');
  else if (f.studentStatus !== 'ACTIVE') reasons.push('STUDENT_NOT_ACTIVE');
  if (f.alreadyHasTargetEnrollment) reasons.push('ALREADY_PROMOTED');
  // A student in the last class finishes school: nothing about next year applies to them.
  if (!f.isFinal) {
    if (!f.locationInTarget) reasons.push('LOCATION_MISSING');
    else if (!f.nextClassFound) reasons.push('NO_NEXT_CLASS');
  }
  if (!f.hasSection) reasons.push('SECTION_MISSING');
  if (!f.isFinal && f.subjectChoiceIncomplete) reasons.push('SUBJECT_CHOICE_PENDING');
  if (!f.isFinal && !f.programmeOk) reasons.push('PROGRAMME_NOT_VALID');
  return reasons;
}

// ───────────────────────────────────────────────────────────── transfer certificate number

/** `TC/2026-27/0004`. The sequence is the school's own counter and is never reused, even for a cancelled certificate. */
export function formatTcNumber(sessionCode: string, sequence: number): string {
  return `TC/${sessionCode.replace(/[^A-Za-z0-9-]/g, '')}/${String(sequence).padStart(4, '0')}`;
}
