import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { ADMISSION_SETTINGS_FIELDS, type AdmissionMode, type AdmissionNumberPreviewDTO, type AdmissionNumberSettingsData, type AdmissionNumberSettingsDTO, type PreviewAdmissionNumberData } from '@shared';
import { AppError } from '../../core/errors';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { AcademicSession } from '../academic/session.model';
import { Location } from '../locations/location.model';
import type { SchoolDoc } from '../school/school.model';
import { recordStudentAudit } from './audit';
import { requireSchool } from './guards';
import { formatAdmissionNumber, type AdmissionNumberPattern } from './rules';
import { AdmissionNumberSettings, StudentAdmission, type AdmissionNumberSettingsDoc } from './student.models';

/** SPM-03 — admission number settings and the counter. The number is made inside the transaction that saves the student. */

export type EffectiveSettings = Pick<
  AdmissionNumberSettingsDoc,
  'mode' | 'prefix' | 'includeLocationCode' | 'includeYear' | 'padding' | 'nextSequence' | 'readmissionPolicy' | 'sectionCapacityPolicy'
>;

/** What a school gets before anyone opens the settings: automatic numbers like `GPS/2026/00001`, and a warning (not a block) on full sections. */
export function defaultSettings(school: Pick<SchoolDoc, 'schoolCode'>): EffectiveSettings {
  return {
    mode: 'AUTO',
    prefix: school.schoolCode,
    includeLocationCode: false,
    includeYear: true,
    padding: 5,
    nextSequence: 1,
    readmissionPolicy: 'KEEP_OLD',
    sectionCapacityPolicy: 'WARN',
  };
}

export async function getEffectiveSettings(ctx: ServiceContext, school: SchoolDoc, db?: ClientSession): Promise<EffectiveSettings> {
  const row = await AdmissionNumberSettings.findOne({ tenantId: ctx.tenantId, schoolId: school._id }).session(db ?? null).lean<AdmissionNumberSettingsDoc>();
  return row ?? defaultSettings(school);
}

/** The year in an admission number is the year the session starts. */
function yearOf(session: { startDate: string } | null, fallback: string): number {
  return Number((session?.startDate ?? fallback).slice(0, 4));
}

async function patternParts(ctx: ServiceContext, input: { academicSessionId?: string | null; locationId?: string | null }, today: string, db?: ClientSession) {
  const session = input.academicSessionId
    ? await AcademicSession.findOne({ _id: input.academicSessionId, tenantId: ctx.tenantId }).session(db ?? null).select('startDate').lean<{ startDate: string }>()
    : await AcademicSession.findOne({ tenantId: ctx.tenantId, status: 'ACTIVE' }).session(db ?? null).select('startDate').lean<{ startDate: string }>();
  const location = input.locationId
    ? await Location.findOne({ _id: input.locationId, tenantId: ctx.tenantId }).session(db ?? null).select('locationCode').lean<{ locationCode: string }>()
    : await Location.findOne({ tenantId: ctx.tenantId, isPrimary: true }).session(db ?? null).select('locationCode').lean<{ locationCode: string }>();
  return { year: yearOf(session, today), locationCode: location?.locationCode ?? null };
}

function toSettingsDTO(settings: EffectiveSettings, example: string): AdmissionNumberSettingsDTO {
  return {
    mode: settings.mode,
    prefix: settings.prefix,
    includeLocationCode: settings.includeLocationCode,
    includeYear: settings.includeYear,
    padding: settings.padding,
    nextSequence: settings.nextSequence,
    readmissionPolicy: settings.readmissionPolicy,
    sectionCapacityPolicy: settings.sectionCapacityPolicy,
    example,
  };
}

async function exampleFor(ctx: ServiceContext, settings: EffectiveSettings, today: string) {
  const parts = await patternParts(ctx, {}, today);
  return formatAdmissionNumber(settings, { ...parts, sequence: settings.nextSequence });
}

export async function getAdmissionNumberSettings(ctx: ServiceContext): Promise<AdmissionNumberSettingsDTO> {
  const school = await requireSchool(ctx);
  const settings = await getEffectiveSettings(ctx, school);
  return toSettingsDTO(settings, await exampleFor(ctx, settings, new Date().toISOString().slice(0, 10)));
}

const AUDITED = [...ADMISSION_SETTINGS_FIELDS] as const;

export async function updateAdmissionNumberSettings(ctx: ServiceContext, data: AdmissionNumberSettingsData): Promise<AdmissionNumberSettingsDTO> {
  const school = await requireSchool(ctx);
  const saved = await withTransaction(async (db) => {
    const before = await getEffectiveSettings(ctx, school, db);
    if (data.nextSequence !== undefined && data.nextSequence < before.nextSequence) {
      throw AppError.validation({ nextSequence: `The counter can only move forward. The next number is ${before.nextSequence}.` });
    }
    const next = { ...data, nextSequence: data.nextSequence ?? before.nextSequence };
    const changes = diffFields(before, next, AUDITED);
    await AdmissionNumberSettings.updateOne(
      { tenantId: ctx.tenantId, schoolId: school._id },
      { $set: { ...next, updatedBy: ctx.userId }, $setOnInsert: { _id: randomUUID(), createdBy: ctx.userId } },
      { upsert: true, session: db },
    );
    if (changes.length > 0) {
      await recordStudentAudit(ctx, db, { entityType: 'admission_settings', entityId: school._id, action: 'admission_settings.updated', changes, studentId: null });
    }
    return next as EffectiveSettings;
  });
  return toSettingsDTO(saved, await exampleFor(ctx, saved, new Date().toISOString().slice(0, 10)));
}

/** The next free number, without using it. Numbers already taken by hand are skipped, the way the real counter does. */
export async function previewAdmissionNumber(ctx: ServiceContext, data: PreviewAdmissionNumberData): Promise<AdmissionNumberPreviewDTO> {
  const school = await requireSchool(ctx);
  const settings = await getEffectiveSettings(ctx, school);
  if (settings.mode === 'MANUAL') return { mode: 'MANUAL', admissionNumber: null };
  const parts = await patternParts(ctx, data, new Date().toISOString().slice(0, 10));
  let sequence = settings.nextSequence;
  for (let i = 0; i < 50; i += 1, sequence += 1) {
    const candidate = formatAdmissionNumber(settings, { ...parts, sequence });
    if (!(await StudentAdmission.exists({ tenantId: ctx.tenantId, schoolId: school._id, admissionNumber: candidate }))) return { mode: 'AUTO', admissionNumber: candidate };
  }
  return { mode: 'AUTO', admissionNumber: formatAdmissionNumber(settings, { ...parts, sequence }) };
}

export function admissionNumberTaken() {
  return new AppError('ADMISSION_NUMBER_TAKEN', undefined, { fields: { admissionNumber: 'This admission number is already used by another student.' } });
}

/** A duplicate-key error on the admission number becomes the friendly error. */
export function mapAdmissionDuplicate(err: unknown): never {
  if (duplicateKeyFields(err)?.includes('admissionNumber')) throw admissionNumberTaken();
  throw err;
}

/**
 * The number for a new admission, inside the caller's transaction.
 *  - AUTO: the counter moves with `findOneAndUpdate`, so two admins adding students at the same time never get the same number
 *    (the second write conflicts and the transaction is retried). A number already typed in by hand is skipped.
 *  - MANUAL (and migration): the admin typed it. It is checked for uniqueness, and stored upper-case.
 */
export async function resolveAdmissionNumber(
  ctx: ServiceContext,
  school: SchoolDoc,
  input: { mode: AdmissionMode; admissionNumber?: string | undefined; academicSessionId: string; locationId: string; today: string },
  db: ClientSession,
): Promise<string> {
  const settings = await getEffectiveSettings(ctx, school, db);
  const typed = input.admissionNumber;

  if (input.mode === 'MIGRATION' || settings.mode === 'MANUAL') {
    if (!typed) throw new AppError('ADMISSION_NUMBER_MODE_MANUAL', undefined, { fields: { admissionNumber: 'Enter the admission number.' } });
    if (await StudentAdmission.exists({ tenantId: ctx.tenantId, schoolId: school._id, admissionNumber: typed }).session(db)) throw admissionNumberTaken();
    return typed;
  }
  if (typed) throw AppError.validation({ admissionNumber: 'This school makes admission numbers automatically. Leave the number empty.' });

  const parts = await patternParts(ctx, { academicSessionId: input.academicSessionId, locationId: input.locationId }, input.today, db);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // `new: false` returns the row as it was: the number we were handed is the old counter, or 1 when we just created the row.
    const before = await AdmissionNumberSettings.findOneAndUpdate(
      { tenantId: ctx.tenantId, schoolId: school._id },
      {
        $inc: { nextSequence: 1 },
        $setOnInsert: {
          _id: randomUUID(),
          mode: settings.mode,
          prefix: settings.prefix,
          includeLocationCode: settings.includeLocationCode,
          includeYear: settings.includeYear,
          padding: settings.padding,
          readmissionPolicy: settings.readmissionPolicy,
          sectionCapacityPolicy: settings.sectionCapacityPolicy,
          createdBy: ctx.userId,
        },
      },
      { upsert: true, returnDocument: 'before', session: db },
    ).lean<AdmissionNumberSettingsDoc | null>();
    // A brand new row starts at 1 after the increment, but we have just used 1.
    if (!before) await AdmissionNumberSettings.updateOne({ tenantId: ctx.tenantId, schoolId: school._id }, { $set: { nextSequence: 2 } }, { session: db });
    const sequence = before?.nextSequence ?? 1;
    const candidate = formatAdmissionNumber(settings, { ...parts, sequence });
    if (!(await StudentAdmission.exists({ tenantId: ctx.tenantId, schoolId: school._id, admissionNumber: candidate }).session(db))) return candidate;
  }
  throw new AppError('INTERNAL_ERROR', 'Could not find a free admission number. Check the admission number settings.');
}

export type { AdmissionNumberPattern };
