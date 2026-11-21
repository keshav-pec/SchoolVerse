import { createHash, randomUUID } from 'node:crypto';
import {
  createStudentSchema,
  IMPORT_FIELD_LABELS,
  IMPORT_FIELDS,
  IMPORT_MAX_ROWS,
  IMPORT_REQUIRED_FIELDS,
  normalizePhone,
  type CreateImportFields,
  type FixImportRowData,
  type ImportCommitResultDTO,
  type ImportDTO,
  type ImportField,
  type ImportIssueCode,
  type ImportIssueDTO,
  type ImportIssueLevel,
  type ImportIssuesDTO,
  type ImportRowDTO,
  type ImportRowListDTO,
  type ImportRowsQuery,
  type ImportSummaryDTO,
  type MapImportData,
} from '@shared';
import { AppError } from '../../core/errors';
import { toIso } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import { toCsv, parseCsv } from '../../platform/identity/csv';
import { scanFile } from '../../platform/identity/file-checks';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassOffering, SectionOffering, type ClassOfferingDoc, type SectionOfferingDoc, type SubjectOfferingDoc } from '../academic/offering.model';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { Subject } from '../academic/subject.model';
import { Person, type PersonDoc } from '../staff/person.model';
import { todayFor } from '../staff/status';
import { recordStudentAudit } from './audit';
import { classKey, parseGender, parseImportDate, parseRelationship, sectionKey, splitName, splitSubjects, suggestMapping } from './import-rules';
import { requireSchool } from './guards';
import { StudentImport, StudentImportRow, type StudentImportDoc, type StudentImportRowDoc } from './records.models';
import { checkSubjectSelection, nameKey } from './rules';
import { getEffectiveSettings } from './settings.service';
import { Student, StudentAdmission, StudentGuardianLink, StudentSectionAssignment } from './student.models';
import { createStudent } from './student.service';
import { loadClassRules, saveSelection, type ClassRules } from './subject.service';

/**
 * SPM-32 — importing students from a CSV file. The file is read once and its rows kept; the admin matches columns (the server
 * suggests the match from common headers), the server checks every row, and only the READY rows are imported. Each student is its
 * own transaction (student, person, admission, enrollment, section, roll number, subjects, guardian), and a row that was imported is
 * remembered by an idempotency key, so running a commit again never makes the same student twice. No student value is logged.
 */

// ───────────────────────────────────────────────────────────── messages

const ISSUE_TEXT: Record<ImportIssueCode, { title: string; fix: string }> = {
  NAME_MISSING: { title: 'Student name is missing', fix: 'Fill in the student’s name in this row.' },
  DUPLICATE_ADMISSION_NUMBER_IN_FILE: { title: 'The same admission number appears twice in the file', fix: 'Give each student their own admission number.' },
  ADMISSION_NUMBER_TAKEN: { title: 'Admission number is already used in the school', fix: 'Check the student list. If this student is already there, leave this row out.' },
  ADMISSION_NUMBER_MISSING: { title: 'Admission number is missing', fix: 'Add the original admission number from the old records.' },
  UNKNOWN_CLASS: { title: 'Class not found', fix: 'Write the class the way it is set up here, for example VIII or Class 8.' },
  UNKNOWN_SECTION: { title: 'Section not found', fix: 'Use one of the sections set up for this class, or leave the section empty.' },
  SECTION_CLASS_MISMATCH: { title: 'Section does not belong to the class', fix: 'Choose a section that this class has.' },
  CLASS_NOT_OFFERED: { title: 'Class is not offered at this campus', fix: 'Choose a class that this campus teaches in the session, or add it in Academic Setup.' },
  INVALID_DATE: { title: 'Date is missing or not valid', fix: 'Use a real date such as 2014-05-20 or 20/05/2014.' },
  POSSIBLE_DUPLICATE_STUDENT: { title: 'Looks like a student who is already here', fix: 'Open the student list and check. If it is a different child, add them by hand.' },
  PARENT_FOUND: { title: 'Parent already in the school (will be reused)', fix: 'Nothing to do. The student will be linked to the existing parent.' },
  GUARDIAN_PROBLEM: { title: 'Parent details need fixing', fix: 'Add the parent’s name, and a valid phone number or email.' },
  SECTION_FULL: { title: 'Section is over its limit', fix: 'You can still import. Check the section size afterwards.' },
  ROLL_NUMBER_CLASH: { title: 'Roll number is used twice in the section', fix: 'Give each student in a section their own roll number.' },
  INVALID_SUBJECT_CHOICE: { title: 'Subject choice does not follow the class rules', fix: 'Check the subject names and the number of choices for this class.' },
  NO_ACTIVE_SESSION: { title: 'The session cannot take new students', fix: 'Choose a session that is published or active.' },
};

const ERROR_LEVEL: ImportIssueLevel = 'ERROR';

// ───────────────────────────────────────────────────────────── helpers

async function loadImport(ctx: ServiceContext, importId: string): Promise<StudentImportDoc> {
  const doc = await StudentImport.findOne({ _id: importId, tenantId: ctx.tenantId }).lean<StudentImportDoc>();
  if (!doc) throw AppError.notFound('Import not found.');
  return doc;
}

/** The value a row will use for a field: a correction made in the app wins over the file's own cell. */
function valueOf(doc: Pick<StudentImportDoc, 'mapping'>, row: Pick<StudentImportRowDoc, 'raw' | 'fixes'>, field: ImportField): string {
  const fixed = row.fixes?.[field];
  if (fixed !== undefined) return fixed.trim();
  const header = doc.mapping?.[field];
  return header ? (row.raw?.[header] ?? '').trim() : '';
}

function valuesOf(doc: Pick<StudentImportDoc, 'mapping'>, row: Pick<StudentImportRowDoc, 'raw' | 'fixes'>): Partial<Record<ImportField, string>> {
  const out: Partial<Record<ImportField, string>> = {};
  for (const field of IMPORT_FIELDS) {
    const v = valueOf(doc, row, field);
    if (v) out[field] = v;
  }
  return out;
}

function missingRequired(mapping: StudentImportDoc['mapping']): ImportField[] {
  return IMPORT_REQUIRED_FIELDS.filter((f) => !mapping?.[f]);
}

async function summaryOf(ctx: ServiceContext, importId: string, total: number): Promise<ImportSummaryDTO> {
  const grouped = await StudentImportRow.aggregate<{ _id: string; n: number }>([{ $match: { tenantId: ctx.tenantId, importId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const n = (s: string) => grouped.find((g) => g._id === s)?.n ?? 0;
  const ready = n('READY');
  const needs = n('NEEDS_ATTENTION');
  const message = `${total.toLocaleString('en-IN')} row${total === 1 ? '' : 's'}: ${ready.toLocaleString('en-IN')} ready, ${needs.toLocaleString('en-IN')} need${needs === 1 ? 's' : ''} attention${n('IMPORTED') > 0 ? `, ${n('IMPORTED')} imported` : ''}`;
  return { total, ready, needsAttention: needs, imported: n('IMPORTED'), skipped: n('SKIPPED'), message };
}

async function toImportDTO(ctx: ServiceContext, doc: StudentImportDoc): Promise<ImportDTO> {
  return {
    importId: doc._id,
    fileName: doc.fileName,
    mode: doc.mode,
    status: doc.status,
    academicSessionId: doc.academicSessionId,
    locationId: doc.locationId,
    headers: doc.headers,
    mapping: doc.mapping ?? {},
    missingRequired: missingRequired(doc.mapping),
    summary: await summaryOf(ctx, doc._id, doc.rowCount),
    createdAt: toIso(doc.createdAt)!,
  };
}

// ───────────────────────────────────────────────────────────── upload

export async function createImport(ctx: ServiceContext, file: { buffer: Buffer; originalname?: string } | undefined, fields: CreateImportFields): Promise<ImportDTO> {
  if (!file || file.buffer.length === 0) throw new AppError('FILE_REQUIRED');
  // The type comes from the bytes: a CSV is text. Binary content (a PDF, an image, a spreadsheet) is refused before it is read as text.
  if (file.buffer.includes(0)) throw new AppError('IMPORT_FILE_INVALID');
  if (!(await scanFile(file.buffer)).clean) throw new AppError('FILE_REJECTED');
  const school = await requireSchool(ctx);
  const rows = parseCsv(file.buffer.toString('utf8'));
  if (rows.length < 2) throw new AppError('IMPORT_FILE_INVALID');
  const headers = rows[0]!.map((h) => h.trim());
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length) throw new AppError('IMPORT_FILE_INVALID', 'Every column needs its own name in the first row.');
  const body = rows.slice(1);
  if (body.length > IMPORT_MAX_ROWS) throw new AppError('IMPORT_FILE_INVALID', `This file has more than ${IMPORT_MAX_ROWS} rows. Split it into smaller files.`);

  const session = fields.academicSessionId
    ? await AcademicSession.findOne({ _id: fields.academicSessionId, tenantId: ctx.tenantId }).lean<AcademicSessionDoc>()
    : await AcademicSession.findOne({ tenantId: ctx.tenantId, status: 'ACTIVE' }).lean<AcademicSessionDoc>();
  if (!session) throw AppError.notFound('Academic session not found. Choose a session.');
  const mapping = suggestMapping(headers);
  const fileHash = createHash('sha256').update(file.buffer).digest('hex');
  const name = (file.originalname ?? 'students.csv').replace(/[^\w .-]+/g, '_').slice(0, 120) || 'students.csv';

  const id = await withTransaction(async (db) => {
    const [doc] = await StudentImport.create(
      [{ tenantId: ctx.tenantId, schoolId: school._id, fileName: name, fileHash, mode: fields.mode, status: missingRequired(mapping).length === 0 ? 'MAPPED' : 'UPLOADED', academicSessionId: session._id, locationId: fields.locationId, headers, mapping, rowCount: body.length, createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session: db },
    );
    await StudentImportRow.insertMany(
      body.map((cells, i) => ({ _id: randomUUID(), tenantId: ctx.tenantId, importId: doc!._id, rowNumber: i + 2, raw: Object.fromEntries(headers.map((h, c) => [h, cells[c] ?? ''])), fixes: {}, status: 'NEEDS_ATTENTION', issues: [] })),
      { session: db },
    );
    await recordStudentAudit(ctx, db, { entityType: 'import', entityId: doc!._id, action: 'import.created', studentId: null, metadata: { mode: fields.mode, rows: body.length } });
    return doc!._id;
  });
  return toImportDTO(ctx, await loadImport(ctx, id));
}

export async function listImports(ctx: ServiceContext): Promise<ImportDTO[]> {
  const docs = await StudentImport.find({ tenantId: ctx.tenantId }).sort({ createdAt: -1 }).limit(20).lean<StudentImportDoc[]>();
  return Promise.all(docs.map((d) => toImportDTO(ctx, d)));
}

export async function getImport(ctx: ServiceContext, importId: string): Promise<ImportDTO> {
  return toImportDTO(ctx, await loadImport(ctx, importId));
}

export async function mapImport(ctx: ServiceContext, importId: string, data: MapImportData): Promise<ImportDTO> {
  const doc = await loadImport(ctx, importId);
  if (doc.status === 'COMMITTED') throw new AppError('IMPORT_NOT_READY', 'This file has already been imported.');
  const mapping: StudentImportDoc['mapping'] = {};
  const used = new Set<string>();
  for (const [field, header] of Object.entries(data.mapping) as [ImportField, string | null][]) {
    if (!header) {
      mapping[field] = null;
      continue;
    }
    if (!doc.headers.includes(header)) throw AppError.validation({ [field]: 'This column is not in the file.' });
    if (used.has(header)) throw AppError.validation({ [field]: 'This column is already used for another field.' });
    used.add(header);
    mapping[field] = header;
  }
  await withTransaction(async (db) => {
    await StudentImport.updateOne({ _id: importId, tenantId: ctx.tenantId }, { $set: { mapping, status: missingRequired(mapping).length === 0 ? 'MAPPED' : 'UPLOADED', updatedBy: ctx.userId } }, { session: db });
    // A new match changes what every row means, so rows go back to "to be checked".
    await StudentImportRow.updateMany({ tenantId: ctx.tenantId, importId, status: { $in: ['READY', 'NEEDS_ATTENTION'] } }, { $set: { status: 'NEEDS_ATTENTION', issues: [] } }, { session: db });
    await recordStudentAudit(ctx, db, { entityType: 'import', entityId: importId, action: 'import.mapped', studentId: null, metadata: { mapped: Object.values(mapping).filter(Boolean).length } });
  });
  return getImport(ctx, importId);
}

// ───────────────────────────────────────────────────────────── validation

interface ClassInfo {
  offering: ClassOfferingDoc;
  sections: Map<string, SectionOfferingDoc>;
  rules: ClassRules;
  subjectByName: Map<string, string>;
}

interface World {
  session: AcademicSessionDoc;
  sessionUsable: boolean;
  classes: Map<string, ClassInfo>;
  takenNumbers: Set<string>;
  occupancy: Map<string, number>;
  takenRolls: Map<string, Set<string>>;
  blockWhenFull: boolean;
  autoNumbers: boolean;
  existingStudents: Map<string, string>;
  guardianPeople: { byEmail: Map<string, string[]>; byPhone: Map<string, string[]> };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function buildWorld(ctx: ServiceContext, doc: StudentImportDoc, rows: StudentImportRowDoc[], today: string): Promise<World> {
  const school = await requireSchool(ctx);
  const session = (await AcademicSession.findOne({ _id: doc.academicSessionId, tenantId: ctx.tenantId }).lean<AcademicSessionDoc>())!;
  const settings = await getEffectiveSettings(ctx, school);
  const offerings = await ClassOffering.find({ tenantId: ctx.tenantId, sessionId: session._id, locationId: doc.locationId, status: 'ACTIVE' }).lean<ClassOfferingDoc[]>();
  const sections = await SectionOffering.find({ tenantId: ctx.tenantId, classOfferingId: { $in: offerings.map((o) => o._id) }, status: 'ACTIVE' }).lean<SectionOfferingDoc[]>();

  const classes = new Map<string, ClassInfo>();
  for (const offering of offerings) {
    const rules = await loadClassRules(ctx, offering._id);
    const subjects = await Subject.find({ tenantId: ctx.tenantId, _id: { $in: rules.offerings.map((o: SubjectOfferingDoc) => o.subjectId) } }).select('name subjectCode').lean<{ _id: string; name: string; subjectCode: string }[]>();
    const subjectByName = new Map<string, string>();
    for (const o of rules.offerings.filter((x: SubjectOfferingDoc) => x.status === 'ACTIVE')) {
      const s = subjects.find((x) => x._id === o.subjectId);
      if (s) {
        subjectByName.set(s.name.toLowerCase(), o._id);
        subjectByName.set(s.subjectCode.toLowerCase(), o._id);
      }
    }
    const info: ClassInfo = { offering, sections: new Map(sections.filter((s) => s.classOfferingId === offering._id).map((s) => [s.sectionCode.toUpperCase(), s])), rules, subjectByName };
    classes.set(classKey(offering.displayCode), info);
    classes.set(classKey(offering.displayName), info);
  }

  const [numbers, loads, rolls, students] = await Promise.all([
    StudentAdmission.distinct('admissionNumber', { tenantId: ctx.tenantId, schoolId: school._id }) as Promise<string[]>,
    StudentSectionAssignment.aggregate<{ _id: string; n: number }>([{ $match: { tenantId: ctx.tenantId, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }], sectionId: { $in: sections.map((s) => s._id) } } }, { $group: { _id: '$sectionId', n: { $sum: 1 } } }]),
    StudentSectionAssignment.find({ tenantId: ctx.tenantId, cancelledAt: null, effectiveTo: null, rollNumber: { $ne: null }, sectionId: { $in: sections.map((s) => s._id) } }).select('sectionId rollNumber').lean<{ sectionId: string; rollNumber: string }[]>(),
    Student.find({ tenantId: ctx.tenantId }).select('personId').lean<{ _id: string; personId: string }[]>(),
  ]);
  const takenRolls = new Map<string, Set<string>>();
  for (const r of rolls) takenRolls.set(r.sectionId, new Set([...(takenRolls.get(r.sectionId) ?? []), r.rollNumber.toUpperCase()]));

  const people = await Person.find({ tenantId: ctx.tenantId, _id: { $in: students.map((s) => s.personId) }, dateOfBirth: { $ne: null } }).select('legalFirstName legalMiddleName legalLastName dateOfBirth').lean<PersonDoc[]>();
  const studentOfPerson = new Map(students.map((s) => [s.personId, s._id]));
  const existingStudents = new Map(people.map((p) => [`${nameKey(p.legalFirstName, p.legalMiddleName, p.legalLastName)}|${p.dateOfBirth}`, studentOfPerson.get(p._id)!]));

  // Parents already in the school, found by the email or phone in the file.
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const row of rows) {
    const email = valueOf(doc, row, 'guardianEmail').toLowerCase();
    const phone = normalizePhone(valueOf(doc, row, 'guardianPhone'));
    if (EMAIL.test(email)) emails.add(email);
    if (phone) phones.add(phone);
  }
  const found = emails.size + phones.size > 0 ? await Person.find({ tenantId: ctx.tenantId, $or: [{ primaryEmail: { $in: [...emails] } }, { primaryPhone: { $in: [...phones] } }] }).select('primaryEmail primaryPhone').lean<PersonDoc[]>() : [];
  const guardianIds = new Set((await StudentGuardianLink.distinct('guardianPersonId', { tenantId: ctx.tenantId, guardianPersonId: { $in: found.map((p) => p._id) } })) as string[]);
  const byEmail = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  for (const p of found.filter((x) => guardianIds.has(x._id))) {
    if (p.primaryEmail) byEmail.set(p.primaryEmail, [...(byEmail.get(p.primaryEmail) ?? []), p._id]);
    if (p.primaryPhone) byPhone.set(p.primaryPhone, [...(byPhone.get(p.primaryPhone) ?? []), p._id]);
  }

  return {
    session,
    sessionUsable: ['PUBLISHED', 'ACTIVE'].includes(session.status),
    classes,
    takenNumbers: new Set(numbers.map((n) => n.toUpperCase())),
    occupancy: new Map(loads.map((l) => [l._id, l.n])),
    takenRolls,
    blockWhenFull: settings.sectionCapacityPolicy === 'BLOCK',
    autoNumbers: settings.mode === 'AUTO',
    existingStudents,
    guardianPeople: { byEmail, byPhone },
  };
}

/** The existing parent for this row: the one with the same email, else the only one with the same phone. Otherwise a new parent is made. */
function matchGuardian(world: World, email: string, phone: string | null): string | null {
  const byEmail = EMAIL.test(email) ? world.guardianPeople.byEmail.get(email) : undefined;
  if (byEmail?.length === 1) return byEmail[0]!;
  const byPhone = phone ? world.guardianPeople.byPhone.get(phone) : undefined;
  return byPhone?.length === 1 ? byPhone[0]! : null;
}

function checkRow(doc: StudentImportDoc, row: StudentImportRowDoc, world: World, trackers: Trackers): ImportIssueDTO[] {
  const issues: ImportIssueDTO[] = [];
  const add = (code: ImportIssueCode, level: ImportIssueLevel, field: ImportField | null, message?: string) => issues.push({ code, level, field, message: message ?? ISSUE_TEXT[code].title, suggestedFix: ISSUE_TEXT[code].fix });
  const v = (f: ImportField) => valueOf(doc, row, f);

  if (!world.sessionUsable) add('NO_ACTIVE_SESSION', ERROR_LEVEL, null);

  const name = v('studentName');
  if (!name) add('NAME_MISSING', ERROR_LEVEL, 'studentName');

  // Class, section.
  const classText = v('className');
  const info = classText ? world.classes.get(classKey(classText)) : undefined;
  if (!classText || !info) add(classText ? 'CLASS_NOT_OFFERED' : 'UNKNOWN_CLASS', ERROR_LEVEL, 'className', classText ? `“${classText}” is not offered at this campus in this session.` : undefined);
  let section: SectionOfferingDoc | undefined;
  const sectionText = v('sectionName');
  if (sectionText && info) {
    section = info.sections.get(sectionKey(sectionText));
    if (!section) {
      const elsewhere = [...world.classes.values()].some((c) => c.sections.has(sectionKey(sectionText)));
      add(elsewhere ? 'SECTION_CLASS_MISMATCH' : 'UNKNOWN_SECTION', ERROR_LEVEL, 'sectionName', elsewhere ? `This class has no section ${sectionKey(sectionText)}.` : undefined);
    }
  }

  // Dates.
  const dobText = v('dateOfBirth');
  const dob = dobText ? parseImportDate(dobText) : null;
  if (dobText && !dob) add('INVALID_DATE', ERROR_LEVEL, 'dateOfBirth', 'The date of birth is not a real date.');
  const admissionText = v('admissionDate');
  const admissionDate = admissionText ? parseImportDate(admissionText) : null;
  if (admissionText && !admissionDate) add('INVALID_DATE', ERROR_LEVEL, 'admissionDate', 'The admission date is not a real date.');
  else if (doc.mode === 'EXISTING_STUDENTS' && !admissionDate) add('INVALID_DATE', ERROR_LEVEL, 'admissionDate', 'Add the original admission date from the old records.');
  else if (admissionDate && admissionDate > world.session.endDate) add('INVALID_DATE', ERROR_LEVEL, 'admissionDate', 'The admission date is after the end of this session.');

  // Admission number.
  const number = v('admissionNumber').toUpperCase();
  const needsNumber = doc.mode === 'EXISTING_STUDENTS' || !world.autoNumbers;
  if (!number && needsNumber) add('ADMISSION_NUMBER_MISSING', ERROR_LEVEL, 'admissionNumber');
  if (number && needsNumber) {
    const first = trackers.numbers.get(number);
    if (first !== undefined) add('DUPLICATE_ADMISSION_NUMBER_IN_FILE', ERROR_LEVEL, 'admissionNumber', `Row ${first} already uses this admission number.`);
    else trackers.numbers.set(number, row.rowNumber);
    if (world.takenNumbers.has(number)) add('ADMISSION_NUMBER_TAKEN', ERROR_LEVEL, 'admissionNumber');
  }

  // Possible duplicate: same name and birth date, in the school or earlier in the file.
  if (name && dob) {
    const parts = splitName(name);
    const key = `${nameKey(parts.first, parts.middle, parts.last)}|${dob}`;
    const earlier = trackers.people.get(key);
    if (world.existingStudents.has(key)) add('POSSIBLE_DUPLICATE_STUDENT', ERROR_LEVEL, 'studentName');
    else if (earlier !== undefined) add('POSSIBLE_DUPLICATE_STUDENT', ERROR_LEVEL, 'studentName', `Same name and date of birth as row ${earlier}.`);
    else trackers.people.set(key, row.rowNumber);
  }

  // Parent.
  const guardianName = v('guardianName');
  const email = v('guardianEmail').toLowerCase();
  const phoneText = v('guardianPhone');
  const phone = phoneText ? normalizePhone(phoneText) : null;
  if (!guardianName) add('GUARDIAN_PROBLEM', ERROR_LEVEL, 'guardianName', 'The parent’s name is missing.');
  if (phoneText && !phone) add('GUARDIAN_PROBLEM', ERROR_LEVEL, 'guardianPhone', 'The parent’s phone number is not valid.');
  if (email && !EMAIL.test(email)) add('GUARDIAN_PROBLEM', ERROR_LEVEL, 'guardianEmail', 'The parent’s email is not valid.');
  if (guardianName && matchGuardian(world, email, phone)) add('PARENT_FOUND', 'INFO', 'guardianName');

  // Section size and roll numbers.
  if (section && info) {
    const planned = (world.occupancy.get(section._id) ?? 0) + (trackers.added.get(section._id) ?? 0);
    trackers.added.set(section._id, (trackers.added.get(section._id) ?? 0) + 1);
    if (section.capacity !== null && section.capacity !== undefined && planned >= section.capacity) {
      add('SECTION_FULL', world.blockWhenFull ? ERROR_LEVEL : 'WARNING', 'sectionName', `${section.displayName} would have ${planned + 1} of ${section.capacity} students.`);
    }
    const roll = v('rollNumber').toUpperCase();
    if (roll) {
      const used = world.takenRolls.get(section._id) ?? new Set<string>();
      const inFile = trackers.rolls.get(`${section._id}|${roll}`);
      if (used.has(roll) || inFile !== undefined) add('ROLL_NUMBER_CLASH', ERROR_LEVEL, 'rollNumber', inFile !== undefined ? `Row ${inFile} has the same roll number in this section.` : 'Another student in this section already has this roll number.');
      else trackers.rolls.set(`${section._id}|${roll}`, row.rowNumber);
    }
  } else if (v('rollNumber') && !sectionText) add('UNKNOWN_SECTION', ERROR_LEVEL, 'sectionName', 'A roll number needs a section.');

  // Subjects.
  const subjectText = v('subjects');
  if (subjectText && info) {
    const ids: string[] = [];
    const unknown: string[] = [];
    for (const s of splitSubjects(subjectText)) {
      const id = info.subjectByName.get(s.toLowerCase());
      if (id) ids.push(id);
      else unknown.push(s);
    }
    if (unknown.length > 0) add('INVALID_SUBJECT_CHOICE', ERROR_LEVEL, 'subjects', `This class does not offer: ${unknown.join(', ')}.`);
    else {
      const result = checkSubjectSelection({ ...info.rules.check, programme: null, selected: ids, addMandatory: true });
      if (!result.valid) add('INVALID_SUBJECT_CHOICE', ERROR_LEVEL, 'subjects', result.problems.map((p) => p.message).join(' '));
    }
  }
  return issues;
}

interface Trackers {
  numbers: Map<string, number>;
  people: Map<string, number>;
  added: Map<string, number>;
  rolls: Map<string, number>;
}

/** Checks every row that has not been imported yet. Each row becomes READY (no error) or NEEDS_ATTENTION. Nothing is created. */
export async function validateImport(ctx: ServiceContext, importId: string): Promise<ImportDTO> {
  const doc = await loadImport(ctx, importId);
  if (doc.status === 'UPLOADED') throw new AppError('IMPORT_MAPPING_INCOMPLETE', undefined, { missing: missingRequired(doc.mapping) });
  const today = await todayFor(ctx);
  const rows = await StudentImportRow.find({ tenantId: ctx.tenantId, importId, status: { $in: ['READY', 'NEEDS_ATTENTION'] } }).sort({ rowNumber: 1 }).lean<StudentImportRowDoc[]>();
  const world = await buildWorld(ctx, doc, rows, today);
  const trackers: Trackers = { numbers: new Map(), people: new Map(), added: new Map(), rolls: new Map() };

  const updates = rows.map((row) => {
    const issues = checkRow(doc, row, world, trackers);
    const status = issues.some((i) => i.level === 'ERROR') ? 'NEEDS_ATTENTION' : 'READY';
    return { updateOne: { filter: { _id: row._id, tenantId: ctx.tenantId }, update: { $set: { status, issues } } } };
  });
  await withTransaction(async (db) => {
    if (updates.length > 0) await StudentImportRow.bulkWrite(updates, { session: db });
    await StudentImport.updateOne({ _id: importId, tenantId: ctx.tenantId }, { $set: { status: 'VALIDATED', updatedBy: ctx.userId } }, { session: db });
    await recordStudentAudit(ctx, db, { entityType: 'import', entityId: importId, action: 'import.validated', studentId: null, metadata: { rows: rows.length } });
  });
  return getImport(ctx, importId);
}

// ───────────────────────────────────────────────────────────── review

function toRowDTO(doc: StudentImportDoc, row: StudentImportRowDoc): ImportRowDTO {
  return { rowId: row._id, rowNumber: row.rowNumber, status: row.status, values: valuesOf(doc, row), issues: row.issues ?? [], studentId: row.studentId ?? null };
}

/** Only the rows that need attention are listed unless a status is asked for. */
export async function listRows(ctx: ServiceContext, importId: string, query: ImportRowsQuery): Promise<ImportRowListDTO> {
  const doc = await loadImport(ctx, importId);
  const filter = { tenantId: ctx.tenantId, importId, status: query.status ?? 'NEEDS_ATTENTION' };
  const [rows, total] = await Promise.all([
    StudentImportRow.find(filter).sort({ rowNumber: 1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<StudentImportRowDoc[]>(),
    StudentImportRow.countDocuments(filter),
  ]);
  return { items: rows.map((r) => toRowDTO(doc, r)), page: query.page, pageSize: query.pageSize, total };
}

/** Saves corrections for one row. The row goes back to "to be checked" until the file is validated again. */
export async function fixRow(ctx: ServiceContext, importId: string, rowId: string, data: FixImportRowData): Promise<ImportRowDTO> {
  const doc = await loadImport(ctx, importId);
  const row = await StudentImportRow.findOne({ _id: rowId, importId, tenantId: ctx.tenantId }).lean<StudentImportRowDoc>();
  if (!row) throw AppError.notFound('Row not found.');
  if (row.status === 'IMPORTED') throw new AppError('IMPORT_NOT_READY', 'This row has already been imported.');
  const fixes = { ...row.fixes, ...data.values };
  await StudentImportRow.updateOne({ _id: rowId, tenantId: ctx.tenantId }, { $set: { fixes, status: 'NEEDS_ATTENTION', issues: [] } });
  return toRowDTO(doc, (await StudentImportRow.findOne({ _id: rowId, tenantId: ctx.tenantId }).lean<StudentImportRowDoc>())!);
}

export async function getIssues(ctx: ServiceContext, importId: string): Promise<ImportIssuesDTO> {
  const doc = await loadImport(ctx, importId);
  const rows = await StudentImportRow.find({ tenantId: ctx.tenantId, importId, 'issues.0': { $exists: true } }).sort({ rowNumber: 1 }).select('rowNumber issues status').lean<Pick<StudentImportRowDoc, 'rowNumber' | 'issues' | 'status'>[]>();
  const groups = new Map<ImportIssueCode, { level: ImportIssueLevel; rowNumbers: number[] }>();
  for (const row of rows) {
    for (const issue of row.issues) {
      const g = groups.get(issue.code) ?? { level: issue.level, rowNumbers: [] };
      if (!g.rowNumbers.includes(row.rowNumber)) g.rowNumbers.push(row.rowNumber);
      groups.set(issue.code, g);
    }
  }
  const order: Record<ImportIssueLevel, number> = { ERROR: 0, WARNING: 1, INFO: 2 };
  return {
    summary: await summaryOf(ctx, importId, doc.rowCount),
    groups: [...groups.entries()]
      .map(([code, g]) => ({ code, level: g.level, title: ISSUE_TEXT[code].title, suggestedFix: ISSUE_TEXT[code].fix, count: g.rowNumbers.length, rowNumbers: g.rowNumbers.slice(0, 200) }))
      .sort((a, b) => order[a.level] - order[b.level] || b.count - a.count),
  };
}

/** The error report: row, field, problem and a suggested fix. It holds no student values, only what to fix and where. */
export async function issuesCsv(ctx: ServiceContext, importId: string): Promise<string> {
  await loadImport(ctx, importId);
  const rows = await StudentImportRow.find({ tenantId: ctx.tenantId, importId, 'issues.0': { $exists: true } }).sort({ rowNumber: 1 }).lean<StudentImportRowDoc[]>();
  const cells = rows.flatMap((r) => r.issues.filter((i) => i.level !== 'INFO').map((i) => [r.rowNumber, i.field ? IMPORT_FIELD_LABELS[i.field] : '', i.message, i.suggestedFix]));
  return `\uFEFF${toCsv(['Row', 'Field', 'Problem', 'Suggested fix'], cells)}`;
}

export function templateCsv(): string {
  const header = ['Student Name', 'Date of Birth', 'Gender', 'Admission No', 'Admission Date', 'Class', 'Section', 'Roll No', 'Father Name', 'Father Mobile', 'Father Email', 'Subjects'];
  const example = ['Riya Sharma', '2014-05-20', 'Female', 'GPS/2019/00123', '2019-04-01', 'VI', 'A', '12', 'Rajesh Sharma', '+91 98765 43210', 'rajesh.sharma@example.com', 'Punjabi'];
  return `\uFEFF${toCsv(header, [example])}`;
}

// ───────────────────────────────────────────────────────────── commit

/** Imports only the READY rows, one student per transaction. Running it again skips rows already imported and never makes a student twice. */
export async function commitImport(ctx: ServiceContext, importId: string): Promise<ImportCommitResultDTO> {
  const doc = await loadImport(ctx, importId);
  if (doc.status !== 'VALIDATED' && doc.status !== 'COMMITTED') throw new AppError('IMPORT_NOT_READY');
  const today = await todayFor(ctx);
  const rows = await StudentImportRow.find({ tenantId: ctx.tenantId, importId, status: 'READY' }).sort({ rowNumber: 1 }).lean<StudentImportRowDoc[]>();
  const world = await buildWorld(ctx, doc, rows, today);
  const counts = { imported: 0, skipped: 0, failed: 0 };

  for (const row of rows) {
    const v = (f: ImportField) => valueOf(doc, row, f);
    const info = world.classes.get(classKey(v('className')))!;
    const number = v('admissionNumber').toUpperCase();
    const key = createHash('sha256').update(`${doc.fileHash}:${row.rowNumber}:${number}`).digest('hex');
    // Claim the row first: a second run (or a second import of the same file) cannot claim it again.
    try {
      await StudentImportRow.updateOne({ _id: row._id, tenantId: ctx.tenantId, status: 'READY' }, { $set: { idempotencyKey: key } });
    } catch (err) {
      if (duplicateKeyFields(err)?.includes('idempotencyKey')) {
        await StudentImportRow.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { status: 'SKIPPED', issues: [{ code: 'ADMISSION_NUMBER_TAKEN', level: 'INFO', field: null, message: 'Already imported from this file.', suggestedFix: 'Nothing to do.' }] } });
        counts.skipped += 1;
        continue;
      }
      throw err;
    }
    try {
      const name = splitName(v('studentName'));
      const section = v('sectionName') ? info.sections.get(sectionKey(v('sectionName'))) : undefined;
      const email = v('guardianEmail').toLowerCase();
      const phone = v('guardianPhone') ? normalizePhone(v('guardianPhone')) : null;
      const reuse = matchGuardian(world, email, phone);
      const guardianName = splitName(v('guardianName'));
      const body = createStudentSchema.parse({
        legalFirstName: name.first,
        ...(name.middle ? { legalMiddleName: name.middle } : {}),
        legalLastName: name.last,
        ...(v('dateOfBirth') ? { dateOfBirth: parseImportDate(v('dateOfBirth')) } : {}),
        ...(v('gender') ? { gender: parseGender(v('gender')) } : {}),
        mode: doc.mode === 'EXISTING_STUDENTS' ? 'MIGRATION' : 'NEW_ADMISSION',
        ...(v('admissionDate') ? { admissionDate: parseImportDate(v('admissionDate')) } : {}),
        ...(number && (doc.mode === 'EXISTING_STUDENTS' || !world.autoNumbers) ? { admissionNumber: number } : {}),
        academicSessionId: doc.academicSessionId,
        locationId: doc.locationId,
        classOfferingId: info.offering._id,
        ...(section ? { sectionId: section._id, ...(v('rollNumber') ? { rollNumber: v('rollNumber').toUpperCase() } : {}) } : {}),
        guardian: reuse
          ? { guardianPersonId: reuse, relationshipType: parseRelationship(v('guardianRelationship'), doc.mapping?.guardianName ?? '') }
          : { legalFirstName: guardianName.first, ...(guardianName.last ? { legalLastName: [guardianName.middle, guardianName.last].filter(Boolean).join(' ') } : {}), phone: phone ?? undefined, email: email || undefined, relationshipType: parseRelationship(v('guardianRelationship'), doc.mapping?.guardianName ?? '') },
        confirmNotDuplicate: true,
      });
      const created = await createStudent(ctx, body);
      if (v('subjects') && created.enrollment) {
        const ids = splitSubjects(v('subjects')).map((s) => info.subjectByName.get(s.toLowerCase())).filter((id): id is string => Boolean(id));
        await saveSelection(ctx, created.enrollment.enrollmentId, ids);
      }
      await StudentImportRow.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { status: 'IMPORTED', studentId: created.student.studentId } });
      counts.imported += 1;
    } catch (err) {
      // A row that could not be made goes back to "needs attention" with the reason, and can be fixed and checked again.
      const message = err instanceof AppError ? (err.details?.fields ? Object.values(err.details.fields).join(' ') : err.message) : 'Something went wrong while adding this student.';
      await StudentImportRow.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { status: 'NEEDS_ATTENTION', idempotencyKey: null, issues: [{ code: 'GUARDIAN_PROBLEM', level: 'ERROR', field: null, message, suggestedFix: 'Fix this row and check the file again.' }] } });
      counts.failed += 1;
    }
  }

  await withTransaction(async (db) => {
    await StudentImport.updateOne({ _id: importId, tenantId: ctx.tenantId }, { $set: { status: 'COMMITTED', committedAt: new Date(), updatedBy: ctx.userId } }, { session: db });
    // Who, which file and how many. No student value is written.
    await recordStudentAudit(ctx, db, { entityType: 'import', entityId: importId, action: 'import.committed', studentId: null, metadata: { fileName: doc.fileName, mode: doc.mode, ...counts } });
  });
  return { ...counts, summary: await summaryOf(ctx, importId, doc.rowCount) };
}

