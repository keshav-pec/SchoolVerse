import { IMPORT_FIELDS, RELATIONSHIP_TYPES, type ImportField, type RelationshipType } from '@shared';
import { isRealDate } from '@shared';

/**
 * Pure helpers for the CSV import (Module 4, Part 3): matching the file's headers to our fields, and reading class, section, date,
 * gender, relationship and subject cells the way schools actually write them ("VIII", "Class 8", "8th"; "05/04/2019"). No database here,
 * so every rule can be tested on its own.
 */

// ───────────────────────────────────────────────────────────── headers

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const SYNONYMS: Record<ImportField, string[]> = {
  studentName: ['student name', 'name', 'student', 'full name', 'child name', 'pupil name', 'name of student'],
  dateOfBirth: ['dob', 'date of birth', 'birth date', 'birthdate', 'd o b', 'birthday'],
  gender: ['gender', 'sex'],
  admissionNumber: ['admission no', 'admission number', 'adm no', 'adm number', 'admno', 'admission', 'registration no', 'registration number', 'reg no', 'enrollment no', 'enrolment no'],
  admissionDate: ['admission date', 'date of admission', 'adm date', 'doa', 'joining date', 'date of joining', 'joined on'],
  className: ['class', 'grade', 'std', 'standard', 'class name', 'current class'],
  sectionName: ['section', 'sec', 'division', 'div'],
  rollNumber: ['roll no', 'roll number', 'roll', 'rollno', 'class roll no'],
  guardianName: ['parent name', 'father name', 'mother name', 'guardian name', 'father', 'mother', 'parent', 'father guardian name', 'name of parent', 'fathers name', 'mothers name'],
  guardianPhone: ['father mobile', 'parent mobile', 'mobile', 'phone', 'parent phone', 'contact', 'guardian phone', 'mother mobile', 'father phone', 'contact no', 'mobile no', 'mobile number', 'phone number', 'parent contact'],
  guardianEmail: ['parent email', 'email', 'father email', 'guardian email', 'e mail', 'mother email', 'email id', 'parent email id'],
  guardianRelationship: ['relationship', 'relation', 'parent relation'],
  subjects: ['subjects', 'electives', 'optional subjects', 'subject choice', 'subject choices', 'elective subjects'],
};

/** Suggests which file column fills which field, from common headers ("Student Name", "Admission No", "Class", "Section", "Father Mobile"). A column is used once. */
export function suggestMapping(headers: readonly string[]): Partial<Record<ImportField, string>> {
  const mapping: Partial<Record<ImportField, string>> = {};
  const used = new Set<string>();
  const normalised = headers.map((h) => ({ header: h, key: norm(h) }));
  for (const field of IMPORT_FIELDS) {
    const hit = normalised.find((h) => !used.has(h.header) && SYNONYMS[field].includes(h.key));
    if (hit) {
      mapping[field] = hit.header;
      used.add(hit.header);
    }
  }
  return mapping;
}

// ───────────────────────────────────────────────────────────── class, section

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };

/** "Class 8", "VIII", "8th", "Grade 8" and "8" all become "8"; names such as "Nursery" or "LKG" become their own lower-case text. */
export function classKey(value: string): string {
  const text = value.toLowerCase().replace(/\b(class|grade|std|standard)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, '');
  const roman = ROMAN[text];
  if (roman) return String(roman);
  const digits = /^(\d{1,2})(st|nd|rd|th)?$/.exec(text);
  return digits ? String(Number(digits[1])) : text;
}

/** The section letter: "A", "a", "VIII-A" and "8 A" all give "A". */
export function sectionKey(value: string): string {
  const text = value.trim();
  const last = text.split(/[-\s/]+/).filter(Boolean).at(-1) ?? '';
  return last.toUpperCase();
}

// ───────────────────────────────────────────────────────────── dates, gender, relationship

/** `2019-04-01`, `01/04/2019`, `01-04-2019` and `1.4.2019` (day first, as in India) all become `2019-04-01`. Anything else, or a date that does not exist, is null. */
export function parseImportDate(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  let iso: string | null = null;
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const pad = (n: string) => n.padStart(2, '0');
  if (ymd) iso = `${ymd[1]}-${pad(ymd[2]!)}-${pad(ymd[3]!)}`;
  else if (dmy) iso = `${dmy[3]}-${pad(dmy[2]!)}-${pad(dmy[1]!)}`;
  return iso && isRealDate(iso) ? iso : null;
}

export function parseGender(value: string): 'MALE' | 'FEMALE' | 'OTHER' | null {
  const text = value.trim().toLowerCase();
  if (['m', 'male', 'boy'].includes(text)) return 'MALE';
  if (['f', 'female', 'girl'].includes(text)) return 'FEMALE';
  return text ? 'OTHER' : null;
}

export function parseRelationship(value: string, headerHint = ''): RelationshipType {
  const text = value.trim().toLowerCase();
  const hit = RELATIONSHIP_TYPES.find((r) => r.toLowerCase() === text);
  if (hit) return hit;
  const hint = headerHint.toLowerCase();
  if (hint.includes('father')) return 'Father';
  if (hint.includes('mother')) return 'Mother';
  return 'Other';
}

/** "Maths; Hindi, Physics" → ["Maths", "Hindi", "Physics"]. */
export function splitSubjects(value: string): string[] {
  return value.split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
}

/** A full name in one cell: the first word is the first name, the last word the last name, anything between is the middle name. */
export function splitName(full: string): { first: string; middle: string | null; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] ?? '', middle: null, last: '' };
  return { first: parts[0]!, middle: parts.length > 2 ? parts.slice(1, -1).join(' ') : null, last: parts.at(-1)! };
}
