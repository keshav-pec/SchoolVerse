import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import {
  IDENTIFIER_FIELDS,
  SCHOOL_CODE_FORMAT_MESSAGE,
  SCHOOL_CODE_PATTERN,
  SCHOOL_CODE_TAKEN_MESSAGE,
  SCHOOL_PROFILE_FIELDS,
  suggestSchoolCodeBase,
  type SchoolCodeAvailabilityDTO,
  type SchoolCodeAvailabilityQuery,
  type CreateIdentifierData,
  type CreateSchoolData,
  type SchoolDTO,
  type SchoolIdentifierDTO,
  type UpdateIdentifierData,
  type UpdateSchoolData,
} from '@shared';
import { AppError } from '../../core/errors';
import { escapeRegex, pickDefined, toIso } from '../../core/objects';
import { IMAGE_TYPES, sniffImageType, storage } from '../../core/storage/storage';
import { duplicateKeyFields } from '../../db/errors';
import { SKIP_TENANT_SCOPE } from '../../db/plugins/tenant-scope';
import { withTransaction } from '../../db/transaction';
import { actorFrom, can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit } from '../audit/audit.service';
import { diffFields } from '../audit/diff';
import { SchoolIdentifier, type SchoolIdentifierDoc } from './school-identifier.model';
import { School, type SchoolDoc } from './school.model';

/** SCH-LOC-01 — School Master profile, logo and official identifiers. */

// ───────────────────────────────────────────────────────────── mapping

export function toSchoolDTO(doc: SchoolDoc, options: { includeConfig: boolean }): SchoolDTO {
  return {
    schoolId: doc._id,
    tenantId: doc.tenantId,
    schoolCode: doc.schoolCode,
    legalName: doc.legalName,
    displayName: doc.displayName,
    shortName: doc.shortName ?? null,
    logoUrl: doc.logoUrl ?? null,
    primaryEmail: doc.primaryEmail,
    primaryPhone: doc.primaryPhone,
    alternatePhone: doc.alternatePhone ?? null,
    websiteUrl: doc.websiteUrl ?? null,
    defaultTimezone: doc.defaultTimezone,
    defaultCurrency: doc.defaultCurrency,
    defaultLocale: doc.defaultLocale,
    status: doc.status,
    setupCompleted: doc.setup?.status === 'COMPLETED',
    ...(options.includeConfig
      ? {
          setup: {
            status: doc.setup?.status ?? 'IN_PROGRESS',
            currentStep: doc.setup?.currentStep ?? 1,
            completedAt: toIso(doc.setup?.completedAt),
          },
        }
      : {}),
    createdAt: toIso(doc.createdAt)!,
    updatedAt: toIso(doc.updatedAt)!,
  };
}

export function toSchoolDTOFor(ctx: ServiceContext, doc: SchoolDoc) {
  return toSchoolDTO(doc, { includeConfig: can(ctx, 'school:view_config') });
}

export function toIdentifierDTO(doc: SchoolIdentifierDoc): SchoolIdentifierDTO {
  return {
    identifierId: doc._id,
    schoolId: doc.schoolId,
    identifierType: doc.identifierType,
    identifierValue: doc.identifierValue,
    issuingAuthority: doc.issuingAuthority ?? null,
    issueDate: doc.issueDate ?? null,
    expiryDate: doc.expiryDate ?? null,
    documentUrl: doc.documentUrl ?? null,
    status: doc.status,
    createdAt: toIso(doc.createdAt)!,
    updatedAt: toIso(doc.updatedAt)!,
  };
}

// ───────────────────────────────────────────────────────────── reads

/** Loads a school of the caller's tenant. Other tenants' ids look exactly like missing ids (404). */
export async function getSchoolOrThrow(ctx: ServiceContext, schoolId: string, session?: ClientSession) {
  const school = await School.findOne({ _id: schoolId, tenantId: ctx.tenantId })
    .session(session ?? null)
    .lean<SchoolDoc>();
  if (!school) throw AppError.notFound('School not found.');
  return school;
}

/** The tenant's School Master, or `null` before onboarding has created it. */
export async function getCurrentSchool(ctx: ServiceContext) {
  return School.findOne({ tenantId: ctx.tenantId }).lean<SchoolDoc>();
}

// ───────────────────────────────────────────────────────────── create / update

function mapSchoolDuplicate(err: unknown): never {
  const fields = duplicateKeyFields(err);
  if (fields?.includes('schoolCode')) {
    throw new AppError('SCHOOL_CODE_TAKEN', undefined, { fields: { schoolCode: SCHOOL_CODE_TAKEN_MESSAGE } });
  }
  if (fields?.length === 1 && fields[0] === 'tenantId') throw new AppError('SCHOOL_ALREADY_EXISTS');
  throw err;
}

// ───────────────────────────────────────────────────────────── school code availability

/** School codes are unique platform-wide; a tenant's own school never counts as a clash. */
async function takenCodes(ctx: ServiceContext, prefix: string): Promise<Set<string>> {
  const rows = await School.find({ tenantId: { $ne: ctx.tenantId }, schoolCode: { $regex: `^${escapeRegex(prefix)}` } })
    .setOptions(SKIP_TENANT_SCOPE)
    .select('schoolCode')
    .lean<{ schoolCode: string }[]>();
  return new Set(rows.map((r) => r.schoolCode));
}

/** First free code for a base: GPS → GPS-2 → GPS-3 … (always ≤ 20 characters). */
async function nextFreeSchoolCode(ctx: ServiceContext, rawBase: string): Promise<string | null> {
  const base = rawBase.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
  if (base.length < 2) return null;
  const stem = base.replace(/-?[0-9]+$/, '') || base;
  const taken = await takenCodes(ctx, stem.slice(0, 15));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem.slice(0, 20 - String(n).length - 1)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** Powers the live availability check + auto-fill suggestion on the School code field. */
export async function checkSchoolCodeAvailability(ctx: ServiceContext, query: SchoolCodeAvailabilityQuery): Promise<SchoolCodeAvailabilityDTO> {
  const name = query.name?.trim();
  const code = query.code?.trim() ? query.code.trim().toUpperCase() : null;
  const fromName = name ? suggestSchoolCodeBase(name) : '';

  if (!code) {
    return { code: null, valid: false, available: false, message: null, suggestion: fromName ? await nextFreeSchoolCode(ctx, fromName) : null };
  }
  if (!SCHOOL_CODE_PATTERN.test(code)) {
    return { code, valid: false, available: false, message: SCHOOL_CODE_FORMAT_MESSAGE, suggestion: await nextFreeSchoolCode(ctx, fromName || code) };
  }
  const clash = await School.exists({ schoolCode: code, tenantId: { $ne: ctx.tenantId } }).setOptions(SKIP_TENANT_SCOPE);
  return {
    code,
    valid: true,
    available: !clash,
    message: clash ? SCHOOL_CODE_TAKEN_MESSAGE : null,
    suggestion: clash ? await nextFreeSchoolCode(ctx, code) : null,
  };
}

export async function createSchool(ctx: ServiceContext, data: CreateSchoolData) {
  const existing = await School.findOne({ tenantId: ctx.tenantId }).select('_id').lean<{ _id: string }>();
  if (existing) throw new AppError('SCHOOL_ALREADY_EXISTS', undefined, { schoolId: existing._id });

  try {
    return await withTransaction(async (session) => {
      const [created] = await School.create(
        [{ ...data, tenantId: ctx.tenantId, createdBy: ctx.userId, updatedBy: ctx.userId }],
        { session },
      );
      const school = created!.toObject() as SchoolDoc;
      await recordAudit(
        {
          tenantId: ctx.tenantId,
          entityType: 'school',
          entityId: school._id,
          action: 'school.created',
          actor: actorFrom(ctx),
          changes: diffFields({}, school, SCHOOL_PROFILE_FIELDS),
          requestId: ctx.requestId,
        },
        session,
      );
      return school;
    });
  } catch (err) {
    mapSchoolDuplicate(err);
  }
}

export async function updateSchool(ctx: ServiceContext, schoolId: string, patch: UpdateSchoolData) {
  const updates = pickDefined(patch);
  try {
    return await withTransaction(async (session) => {
      const before = await getSchoolOrThrow(ctx, schoolId, session);
      const changes = diffFields(before, { ...before, ...updates }, SCHOOL_PROFILE_FIELDS);
      if (changes.length === 0) return before;

      const $set: Record<string, unknown> = { updatedBy: ctx.userId };
      for (const change of changes) $set[change.field] = (updates as Record<string, unknown>)[change.field];

      const after = await School.findOneAndUpdate({ _id: schoolId, tenantId: ctx.tenantId }, { $set }, { session, returnDocument: 'after' })
        .lean<SchoolDoc>();
      await recordAudit(
        {
          tenantId: ctx.tenantId,
          entityType: 'school',
          entityId: schoolId,
          action: 'school.updated',
          actor: actorFrom(ctx),
          changes,
          requestId: ctx.requestId,
        },
        session,
      );
      return after!;
    });
  } catch (err) {
    mapSchoolDuplicate(err);
  }
}

// ───────────────────────────────────────────────────────────── logo

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export async function setSchoolLogo(ctx: ServiceContext, schoolId: string, file: { buffer: Buffer } | undefined) {
  if (!file?.buffer?.length) throw new AppError('FILE_REQUIRED', undefined, { fields: { logo: 'Choose an image to upload.' } });
  const kind = sniffImageType(file.buffer);
  if (!kind) throw new AppError('UNSUPPORTED_FILE_TYPE', undefined, { fields: { logo: 'Upload a PNG, JPEG or WebP image.' } });

  await getSchoolOrThrow(ctx, schoolId); // 404 before touching storage
  // Storage is a side effect, so it happens outside the (retryable) transaction.
  const { url } = await storage.save({
    key: `${ctx.tenantId}/school-logos/${schoolId}-${randomUUID()}.${kind}`,
    body: file.buffer,
    contentType: IMAGE_TYPES[kind],
  });

  let previousUrl: string | null = null;
  try {
    const school = await withTransaction(async (session) => {
      const before = await getSchoolOrThrow(ctx, schoolId, session);
      previousUrl = before.logoUrl ?? null;
      const after = await School.findOneAndUpdate(
        { _id: schoolId, tenantId: ctx.tenantId },
        { $set: { logoUrl: url, updatedBy: ctx.userId } },
        { session, returnDocument: 'after' },
      ).lean<SchoolDoc>();
      await recordAudit(
        {
          tenantId: ctx.tenantId,
          entityType: 'school',
          entityId: schoolId,
          action: 'school.logo_updated',
          actor: actorFrom(ctx),
          changes: [{ field: 'logoUrl', from: previousUrl, to: url }],
          requestId: ctx.requestId,
        },
        session,
      );
      return after!;
    });
    if (previousUrl) await storage.remove(previousUrl);
    return school;
  } catch (err) {
    await storage.remove(url);
    throw err;
  }
}

export async function removeSchoolLogo(ctx: ServiceContext, schoolId: string) {
  let previousUrl: string | null = null;
  const school = await withTransaction(async (session) => {
    const before = await getSchoolOrThrow(ctx, schoolId, session);
    previousUrl = before.logoUrl ?? null;
    if (!previousUrl) return before;
    const after = await School.findOneAndUpdate(
      { _id: schoolId, tenantId: ctx.tenantId },
      { $set: { logoUrl: null, updatedBy: ctx.userId } },
      { session, returnDocument: 'after' },
    ).lean<SchoolDoc>();
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'school',
        entityId: schoolId,
        action: 'school.logo_removed',
        actor: actorFrom(ctx),
        changes: [{ field: 'logoUrl', from: previousUrl, to: null }],
        requestId: ctx.requestId,
      },
      session,
    );
    return after!;
  });
  if (previousUrl) await storage.remove(previousUrl);
  return school;
}

// ───────────────────────────────────────────────────────────── official identifiers

export async function listIdentifiers(ctx: ServiceContext, schoolId: string) {
  await getSchoolOrThrow(ctx, schoolId);
  return SchoolIdentifier.find({ tenantId: ctx.tenantId, schoolId })
    .sort({ status: 1, identifierType: 1, createdAt: 1 })
    .lean<SchoolIdentifierDoc[]>();
}

async function getIdentifierOrThrow(ctx: ServiceContext, schoolId: string, identifierId: string, session: ClientSession) {
  const doc = await SchoolIdentifier.findOne({ _id: identifierId, tenantId: ctx.tenantId, schoolId })
    .session(session)
    .lean<SchoolIdentifierDoc>();
  if (!doc) throw AppError.notFound('Identifier not found.');
  return doc;
}

export async function createIdentifier(ctx: ServiceContext, schoolId: string, data: CreateIdentifierData) {
  return withTransaction(async (session) => {
    await getSchoolOrThrow(ctx, schoolId, session);
    const [created] = await SchoolIdentifier.create(
      [{ ...data, tenantId: ctx.tenantId, schoolId, createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session },
    );
    const doc = created!.toObject() as SchoolIdentifierDoc;
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'school_identifier',
        entityId: doc._id,
        action: 'school_identifier.created',
        actor: actorFrom(ctx),
        changes: diffFields({}, doc, IDENTIFIER_FIELDS),
        metadata: { schoolId, identifierType: doc.identifierType },
        requestId: ctx.requestId,
      },
      session,
    );
    return doc;
  });
}

export async function updateIdentifier(
  ctx: ServiceContext,
  schoolId: string,
  identifierId: string,
  patch: UpdateIdentifierData,
) {
  const updates = pickDefined(patch);
  return withTransaction(async (session) => {
    const before = await getIdentifierOrThrow(ctx, schoolId, identifierId, session);
    const merged = { ...before, ...updates };
    if (merged.issueDate && merged.expiryDate && merged.expiryDate < merged.issueDate) {
      throw AppError.validation({ expiryDate: 'Expiry date must be on or after the issue date.' });
    }
    const changes = diffFields(before, merged, IDENTIFIER_FIELDS);
    if (changes.length === 0) return before;

    const $set: Record<string, unknown> = { updatedBy: ctx.userId };
    for (const change of changes) $set[change.field] = (updates as Record<string, unknown>)[change.field];
    const after = await SchoolIdentifier.findOneAndUpdate(
      { _id: identifierId, tenantId: ctx.tenantId, schoolId },
      { $set },
      { session, returnDocument: 'after' },
    ).lean<SchoolIdentifierDoc>();
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'school_identifier',
        entityId: identifierId,
        action: 'school_identifier.updated',
        actor: actorFrom(ctx),
        changes,
        metadata: { schoolId, identifierType: after!.identifierType },
        requestId: ctx.requestId,
      },
      session,
    );
    return after!;
  });
}

/** Mistakes can be removed; superseded identifiers should be kept with status SUPERSEDED instead. */
export async function deleteIdentifier(ctx: ServiceContext, schoolId: string, identifierId: string) {
  await withTransaction(async (session) => {
    const before = await getIdentifierOrThrow(ctx, schoolId, identifierId, session);
    await SchoolIdentifier.deleteOne({ _id: identifierId, tenantId: ctx.tenantId, schoolId }, { session });
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'school_identifier',
        entityId: identifierId,
        action: 'school_identifier.deleted',
        actor: actorFrom(ctx),
        changes: diffFields(before, {}, IDENTIFIER_FIELDS),
        metadata: { schoolId, identifierType: before.identifierType },
        requestId: ctx.requestId,
      },
      session,
    );
  });
}
