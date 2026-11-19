import type { ChoiceRuleType, ConstraintType, OfferingStatus, RuleVersionStatus, SessionStatus, SubjectOfferingType, ValidationIssueDTO, ValidationLevel } from '@shared';

/**
 * AS-14 — the academic validation engine. A PURE function: plain data in, a list of issues out.
 * It never touches the database, so every rule can be unit-tested with a hand-built snapshot.
 * `validation.service.ts` builds the snapshot and stores the summary.
 *
 * Errors block publishing; warnings and info never do. Messages name the offending group / rule (PRD §16.3).
 */
export interface ValidationInput {
  session: {
    id: string;
    startDate: string;
    endDate: string;
    locations: { locationId: string; boardRuleVersionId: string }[];
  };
  /** By location id. A location that is missing here no longer exists. */
  locations: Record<string, { status: string; name: string } | undefined>;
  /** By rule version id. */
  ruleVersions: Record<string, { status: RuleVersionStatus; name: string } | undefined>;
  otherSessions: { id: string; name: string; startDate: string; endDate: string; status: SessionStatus }[];
  /** By master class id. */
  classes: Record<string, { code: string; sequence: number; isBoardClass: boolean } | undefined>;
  classOfferings: { id: string; locationId: string; classId: string; displayName: string; status: OfferingStatus }[];
  sections: { id: string; classOfferingId: string; status: OfferingStatus }[];
  subjectOfferings: { id: string; classOfferingId: string; subjectName: string; offeringType: SubjectOfferingType; status: OfferingStatus; subjectActive: boolean }[];
  groups: { id: string; classOfferingId: string; name: string; ruleType: ChoiceRuleType; min: number; max: number; status: OfferingStatus; subjectOfferingIds: string[] }[];
  constraints: { id: string; classOfferingId: string; type: ConstraintType; subjectOfferingId: string; otherSubjectOfferingId: string }[];
  programmes: { id: string; locationId: string; name: string; status: OfferingStatus; subjectRules: { subjectOfferingId: string }[] }[];
  terms: { id: string; name: string; locationId: string | null; startDate: string; endDate: string }[];
}

/** Classes whose programmes the dashboard suggests setting up (Class XI and XII). */
const SENIOR_CLASS_CODES = ['G11', 'G12'];

export function validateAcademicSession(input: ValidationInput): ValidationIssueDTO[] {
  const issues: ValidationIssueDTO[] = [];
  const add = (level: ValidationLevel, code: string, message: string, entityType: string, entityId: string) =>
    issues.push({ level, code, message, entityType, entityId });
  const { session } = input;

  const locationName = (locationId: string) => input.locations[locationId]?.name ?? 'an unknown location';
  const activeClasses = input.classOfferings.filter((g) => g.status === 'ACTIVE');
  const classOf = new Map(input.classOfferings.map((g) => [g.id, g]));
  const classLabel = (classOfferingId: string) => {
    const g = classOf.get(classOfferingId);
    return g ? `${g.displayName} at ${locationName(g.locationId)}` : 'an unknown class';
  };
  const offeringOf = new Map(input.subjectOfferings.map((o) => [o.id, o]));
  const usable = (offeringId: string) => {
    const o = offeringOf.get(offeringId);
    return Boolean(o && o.status === 'ACTIVE' && o.subjectActive);
  };
  const nameOf = (offeringId: string) => offeringOf.get(offeringId)?.subjectName ?? 'an unknown subject';
  const activeClassIds = new Set(activeClasses.map((g) => g.id));

  // ── session level
  if (session.startDate >= session.endDate) {
    add('ERROR', 'SESSION_DATES_INVALID', 'The session start date must be before its end date.', 'academic_session', session.id);
  }
  if (session.locations.length === 0) {
    add('ERROR', 'SESSION_NO_LOCATIONS', 'Add at least one location to this session.', 'academic_session', session.id);
  }
  for (const l of session.locations) {
    const location = input.locations[l.locationId];
    if (!location || location.status !== 'ACTIVE') {
      add('ERROR', 'LOCATION_NOT_ACTIVE', `${location?.name ?? 'A location in this session'} is no longer active. Remove it from the session or reactivate it.`, 'session_location', l.locationId);
    }
    const version = input.ruleVersions[l.boardRuleVersionId];
    if (!version) {
      add('ERROR', 'RULE_VERSION_MISSING', `The board rule version for ${locationName(l.locationId)} no longer exists. Choose another one.`, 'session_location', l.locationId);
    } else if (version.status === 'RETIRED') {
      add('WARNING', 'RULE_VERSION_RETIRED', `${locationName(l.locationId)} uses the retired board rule version "${version.name}".`, 'session_location', l.locationId);
    }
  }
  for (const other of input.otherSessions) {
    if (other.status !== 'ARCHIVED' && other.startDate <= session.endDate && session.startDate <= other.endDate) {
      add('WARNING', 'SESSION_DATES_OVERLAP', `These dates overlap with "${other.name}" (${other.startDate} to ${other.endDate}).`, 'academic_session', other.id);
    }
  }

  // ── classes, sections, subjects
  if (activeClasses.length === 0) {
    add('ERROR', 'NO_CLASS_OFFERINGS', 'Add at least one class to this session.', 'academic_session', session.id);
  }
  for (const g of activeClasses) {
    if (!input.sections.some((s) => s.classOfferingId === g.id && s.status === 'ACTIVE')) {
      add('ERROR', 'CLASS_WITHOUT_SECTIONS', `${classLabel(g.id)} has no sections.`, 'class_offering', g.id);
    }
    if (!input.subjectOfferings.some((o) => o.classOfferingId === g.id && o.status === 'ACTIVE')) {
      add('ERROR', 'CLASS_WITHOUT_SUBJECTS', `${classLabel(g.id)} has no subjects.`, 'class_offering', g.id);
    }
  }

  // ── terms
  for (const t of input.terms) {
    if (t.startDate < session.startDate || t.endDate > session.endDate) {
      add('ERROR', 'TERM_OUTSIDE_SESSION', `Term "${t.name}" (${t.startDate} to ${t.endDate}) falls outside the session dates.`, 'academic_term', t.id);
    }
  }
  if (input.terms.length === 0) {
    add('INFO', 'NO_TERMS', 'No terms are set up yet. Add terms if you plan by term or semester.', 'academic_session', session.id);
  }
  for (const g of activeClasses) {
    const schoolClass = input.classes[g.classId];
    if (schoolClass?.isBoardClass) continue;
    if (!input.terms.some((t) => t.locationId === null || t.locationId === g.locationId)) {
      add('WARNING', 'CLASS_WITHOUT_TERMS', `${classLabel(g.id)} has no terms.`, 'class_offering', g.id);
    }
  }

  // ── choice groups
  const activeGroups = input.groups.filter((g) => g.status === 'ACTIVE' && activeClassIds.has(g.classOfferingId));
  for (const group of activeGroups) {
    const eligible = group.subjectOfferingIds.filter(usable).length;
    const where = `Choice group "${group.name}" (${classLabel(group.classOfferingId)})`;
    // "Take all" means every active subject, so it can never ask for more than exists.
    if (group.ruleType !== 'REQUIRED_ALL' && group.min > eligible) {
      add(
        'ERROR',
        'GROUP_MIN_EXCEEDS_ELIGIBLE',
        `${where} needs at least ${group.min} subject${group.min === 1 ? '' : 's'} but only ${eligible} active subject${eligible === 1 ? ' is' : 's are'} available.`,
        'subject_choice_group',
        group.id,
      );
    }
    if (group.min > group.max) {
      add('ERROR', 'GROUP_MIN_GREATER_THAN_MAX', `${where} has a minimum (${group.min}) higher than its maximum (${group.max}).`, 'subject_choice_group', group.id);
    }
    if (group.ruleType !== 'REQUIRED_ALL') {
      for (const id of group.subjectOfferingIds) {
        if (offeringOf.get(id)?.offeringType === 'MANDATORY') {
          add('WARNING', 'MANDATORY_IN_CHOICE_GROUP', `${nameOf(id)} is mandatory but also sits in the optional choice group "${group.name}" (${classLabel(group.classOfferingId)}).`, 'subject_choice_group', group.id);
        }
      }
    }
  }

  // ── constraints
  const constraints = input.constraints.filter((c) => activeClassIds.has(c.classOfferingId));
  const reported = new Set<string>();
  for (const c of constraints) {
    const a = nameOf(c.subjectOfferingId);
    const b = nameOf(c.otherSubjectOfferingId);
    const text = `${a} ${c.type === 'REQUIRES' ? 'requires' : 'excludes'} ${b}`;
    const pair = [c.subjectOfferingId, c.otherSubjectOfferingId].sort().join('|');

    // A requires B together with A excludes B (in either direction, since excluding is mutual) can never be satisfied.
    const opposite = constraints.find(
      (o) =>
        o.id !== c.id &&
        o.classOfferingId === c.classOfferingId &&
        o.type !== c.type &&
        [o.subjectOfferingId, o.otherSubjectOfferingId].sort().join('|') === pair,
    );
    if (opposite && !reported.has(pair)) {
      reported.add(pair);
      const requires = c.type === 'REQUIRES' ? c : opposite;
      const excludes = c.type === 'EXCLUDES' ? c : opposite;
      add(
        'ERROR',
        'CONSTRAINT_CONFLICT',
        `"${nameOf(requires.subjectOfferingId)} requires ${nameOf(requires.otherSubjectOfferingId)}" conflicts with "${nameOf(excludes.subjectOfferingId)} excludes ${nameOf(excludes.otherSubjectOfferingId)}" in ${classLabel(c.classOfferingId)}.`,
        'subject_choice_constraint',
        requires.id,
      );
    }

    if (c.type === 'EXCLUDES') {
      const sameRequiredGroup = activeGroups.some(
        (g) => g.classOfferingId === c.classOfferingId && g.ruleType === 'REQUIRED_ALL' && g.subjectOfferingIds.includes(c.subjectOfferingId) && g.subjectOfferingIds.includes(c.otherSubjectOfferingId),
      );
      const bothMandatory = [c.subjectOfferingId, c.otherSubjectOfferingId].every((id) => offeringOf.get(id)?.offeringType === 'MANDATORY' && offeringOf.get(id)?.status === 'ACTIVE');
      if (sameRequiredGroup || bothMandatory) {
        add(
          'ERROR',
          'EXCLUDES_ON_REQUIRED',
          `"${text}" in ${classLabel(c.classOfferingId)} can never be met because ${sameRequiredGroup ? 'both subjects are in the same "take all" group' : 'both subjects are mandatory'}.`,
          'subject_choice_constraint',
          c.id,
        );
      }
    } else if (usable(c.subjectOfferingId) && !usable(c.otherSubjectOfferingId)) {
      add('ERROR', 'REQUIRES_TARGET_INACTIVE', `"${text}" in ${classLabel(c.classOfferingId)} points at an inactive subject.`, 'subject_choice_constraint', c.id);
    }
  }

  // ── programmes
  for (const p of input.programmes) {
    if (p.status !== 'ACTIVE') continue;
    const inactive = p.subjectRules.filter((r) => !usable(r.subjectOfferingId));
    if (inactive.length > 0) {
      add('ERROR', 'PROGRAMME_INACTIVE_SUBJECT', `Programme "${p.name}" uses inactive subjects: ${inactive.map((r) => nameOf(r.subjectOfferingId)).join(', ')}.`, 'academic_programme', p.id);
    }
  }
  for (const l of session.locations) {
    const hasSenior = activeClasses.some((g) => g.locationId === l.locationId && SENIOR_CLASS_CODES.includes(input.classes[g.classId]?.code ?? ''));
    if (hasSenior && !input.programmes.some((p) => p.locationId === l.locationId && p.status === 'ACTIVE')) {
      add('INFO', 'NO_PROGRAMMES', `${locationName(l.locationId)} has Class XI or XII but no programmes (streams or flexible combinations).`, 'session_location', l.locationId);
    }
  }

  const order: Record<ValidationLevel, number> = { ERROR: 0, WARNING: 1, INFO: 2 };
  return issues.sort((a, b) => order[a.level] - order[b.level]);
}

export function summarizeIssues(issues: ValidationIssueDTO[]) {
  return {
    errors: issues.filter((i) => i.level === 'ERROR').length,
    warnings: issues.filter((i) => i.level === 'WARNING').length,
    info: issues.filter((i) => i.level === 'INFO').length,
  };
}
