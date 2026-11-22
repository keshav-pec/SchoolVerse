import { createHash, randomUUID } from 'node:crypto';
import {
  SPACE_FEATURES,
  SPACE_IMPORT_FIELDS,
  SPACE_IMPORT_FIELD_LABELS,
  SPACE_IMPORT_MAX_ROWS,
  SPACE_IMPORT_REQUIRED_FIELDS,
  SPACE_SUITABILITY_TAGS,
  type CreateSpaceImportFields,
  type MapSpaceImportData,
  type SpaceFeatureCode,
  type SpaceImportCommitDTO,
  type SpaceImportDTO,
  type SpaceImportField,
  type SpaceImportIssueCode,
  type SpaceImportRowDTO,
  type SpaceImportRowListDTO,
  type SpaceImportRowsQuery,
  type SuitabilityTagCode,
} from '@shared';
import { AppError } from '../../core/errors';
import { toIso } from '../../core/objects';
import { withTransaction } from '../../db/transaction';
import { parseCsv, toCsv } from '../../platform/identity/csv';
import { scanFile } from '../../platform/identity/file-checks';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { recordSpaceAudit } from './audit';
import { spaceCodeFrom } from './codes';
import { assertInScope, assertLocationWritable, loadLocation, requireSchool, spaceScope } from './guards';
import { Building, Floor, PhysicalSpace, SpaceImport, SpaceImportRow, SpaceType, type BuildingDoc, type FloorDoc, type SpaceImportDoc, type SpaceImportIssue, type SpaceImportRowDoc, type SpaceTypeDoc } from './space.models';
import { insertSpaces, type SpaceInsert } from './space.service';
import { ensureSystemTypes } from './type.service';

/**
 * SPACE-27 to 31 — importing rooms from a CSV file. The file is read once and its rows kept. The server suggests which column is which,
 * checks every row, and only the READY rows are imported. Each room is its own transaction and its row is claimed first, so running a
 * commit again (or two at once) never makes the same room twice.
 */

const ISSUE_TEXT: Record<SpaceImportIssueCode, { title: string; fix: string }> = {
  NAME_MISSING: { title: 'Room name is missing', fix: 'Fill in the room name in this row.' },
  TYPE_UNKNOWN: { title: 'Room type not found', fix: 'Use one of the room types from the Room Types screen, for example Standard Classroom.' },
  BUILDING_UNKNOWN: { title: 'Building not found', fix: 'Write the building the way it is set up (name or code), or add the building first.' },
  FLOOR_UNKNOWN: { title: 'Floor not found', fix: 'Use a floor of that building (name, code or number), or add the floor first.' },
  INDOOR_NEEDS_FLOOR: { title: 'Room needs a building and a floor', fix: 'Add the building and floor. Only outdoor spaces such as a playground can leave them empty.' },
  OUTDOOR_WITH_FLOOR: { title: 'Outdoor space has a building or floor', fix: 'Leave the building and floor empty for playgrounds and other outdoor spaces.' },
  CAPACITY_INVALID: { title: 'Capacity is not a whole number above zero', fix: 'Use a number such as 40, or leave it empty.' },
  CODE_DUPLICATE_IN_FILE: { title: 'The same room code appears twice in the file', fix: 'Give each room its own code.' },
  CODE_TAKEN: { title: 'Room code is already used at this campus', fix: 'Check the room list. If it is the same room, leave this row out.' },
  FEATURE_UNKNOWN: { title: 'A feature was not recognised', fix: 'Use features such as Smart Board, Projector or Internet, separated by semicolons.' },
  TAG_UNKNOWN: { title: 'A "suitable for" value was not recognised', fix: 'Use values such as General teaching or Chemistry practical, separated by semicolons.' },
};

const SYNONYMS: Record<SpaceImportField, string[]> = {
  building: ['building', 'building name', 'block'],
  floor: ['floor', 'floor name', 'level'],
  spaceCode: ['code', 'room code', 'space code', 'room id'],
  spaceName: ['name', 'room name', 'space name', 'room'],
  roomNumber: ['room number', 'room no', 'number', 'room num'],
  type: ['type', 'room type', 'space type', 'category'],
  physicalCapacity: ['physical capacity', 'capacity', 'max capacity'],
  academicCapacity: ['academic capacity', 'seats', 'seats for classes', 'class capacity'],
  examCapacity: ['exam capacity', 'exam seats'],
  features: ['features', 'facilities', 'amenities'],
  tags: ['tags', 'suitable for', 'suitability'],
};

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function suggestSpaceMapping(headers: string[]): Partial<Record<SpaceImportField, string | null>> {
  const mapping: Partial<Record<SpaceImportField, string | null>> = {};
  const used = new Set<string>();
  for (const field of SPACE_IMPORT_FIELDS) {
    const hit = headers.find((h) => !used.has(h) && (norm(h) === norm(SPACE_IMPORT_FIELD_LABELS[field]) || SYNONYMS[field].includes(norm(h))));
    mapping[field] = hit ?? null;
    if (hit) used.add(hit);
  }
  return mapping;
}

type Values = Partial<Record<SpaceImportField, string>>;

function valuesOf(doc: Pick<SpaceImportDoc, 'mapping'>, row: Pick<SpaceImportRowDoc, 'raw'>): Values {
  const out: Values = {};
  for (const f of SPACE_IMPORT_FIELDS) {
    const header = doc.mapping?.[f];
    const v = header ? (row.raw?.[header] ?? '').trim() : '';
    if (v) out[f] = v;
  }
  return out;
}

const missingRequired = (mapping: SpaceImportDoc['mapping']): SpaceImportField[] => SPACE_IMPORT_REQUIRED_FIELDS.filter((f) => !mapping?.[f]);

interface Lookups {
  types: SpaceTypeDoc[];
  buildings: BuildingDoc[];
  floors: FloorDoc[];
  taken: Set<string>;
}

async function loadLookups(ctx: ServiceContext, locationId: string): Promise<Lookups> {
  await ensureSystemTypes(ctx);
  const [types, buildings, floors, spaces] = await Promise.all([
    SpaceType.find({ tenantId: ctx.tenantId }).lean<SpaceTypeDoc[]>(),
    Building.find({ tenantId: ctx.tenantId, locationId, status: { $ne: 'ARCHIVED' } }).lean<BuildingDoc[]>(),
    Floor.find({ tenantId: ctx.tenantId, locationId, status: { $ne: 'ARCHIVED' } }).lean<FloorDoc[]>(),
    PhysicalSpace.find({ tenantId: ctx.tenantId, locationId }).select('spaceCode').lean<{ spaceCode: string }[]>(),
  ]);
  return { types, buildings, floors, taken: new Set(spaces.map((s) => s.spaceCode)) };
}

const parseCapacity = (text: string | undefined): number | null | 'BAD' => {
  if (!text) return null;
  const n = Number(text);
  return Number.isInteger(n) && n > 0 && n <= 100000 ? n : 'BAD';
};

const parseList = (text: string | undefined) => (text ? text.split(/[;|,]/).map((s) => s.trim()).filter(Boolean) : []);

interface Checked {
  issues: SpaceImportIssue[];
  insert: SpaceInsert | null;
}

/** Reads one row. Everything it learns about the file so far (`seen` codes) and about the campus (`lookups`) is passed in. */
function checkRow(locationId: string, values: Values, lookups: Lookups, seen: Set<string>): Checked {
  const issues: SpaceImportIssue[] = [];
  const add = (code: SpaceImportIssueCode, field: SpaceImportField | null) => issues.push({ code, field });
  if (!values.spaceName) add('NAME_MISSING', 'spaceName');
  const wanted = norm(values.type ?? '');
  const type = wanted ? lookups.types.find((t) => norm(t.name) === wanted || norm(t.code) === wanted) : undefined;
  if (!type) add('TYPE_UNKNOWN', 'type');

  let building: BuildingDoc | undefined;
  let floor: FloorDoc | undefined;
  if (values.building) {
    building = lookups.buildings.find((b) => norm(b.buildingCode) === norm(values.building!) || norm(b.buildingName) === norm(values.building!));
    if (!building) add('BUILDING_UNKNOWN', 'building');
  }
  if (values.floor && building) {
    const w = norm(values.floor);
    floor = lookups.floors.find((f) => f.buildingId === building!._id && (norm(f.floorCode) === w || norm(f.floorName) === w || String(f.floorNumber) === w));
    if (!floor) add('FLOOR_UNKNOWN', 'floor');
  }
  if (type?.isOutdoor && (values.building || values.floor)) add('OUTDOOR_WITH_FLOOR', values.building ? 'building' : 'floor');
  if (type && !type.isOutdoor && !values.building && !values.floor) add('INDOOR_NEEDS_FLOOR', 'floor');
  else if (type && !type.isOutdoor && values.building && !values.floor) add('INDOOR_NEEDS_FLOOR', 'floor');

  const caps = { physicalCapacity: parseCapacity(values.physicalCapacity), academicCapacity: parseCapacity(values.academicCapacity), examCapacity: parseCapacity(values.examCapacity) };
  for (const [k, v] of Object.entries(caps)) if (v === 'BAD') add('CAPACITY_INVALID', k as SpaceImportField);

  const features: SpaceFeatureCode[] = [];
  for (const f of parseList(values.features)) {
    const hit = SPACE_FEATURES.find((x) => norm(x.label) === norm(f) || norm(x.code) === norm(f));
    if (hit) features.push(hit.code);
    else add('FEATURE_UNKNOWN', 'features');
  }
  const tags: SuitabilityTagCode[] = [];
  for (const t of parseList(values.tags)) {
    const hit = SPACE_SUITABILITY_TAGS.find((x) => norm(x.label) === norm(t) || norm(x.code) === norm(t));
    if (hit) tags.push(hit.code);
    else add('TAG_UNKNOWN', 'tags');
  }

  let code: string | null = null;
  if (values.spaceCode) {
    code = values.spaceCode.trim().toUpperCase();
    if (seen.has(code)) add('CODE_DUPLICATE_IN_FILE', 'spaceCode');
    else if (lookups.taken.has(code)) add('CODE_TAKEN', 'spaceCode');
  } else if (values.spaceName) {
    // No code typed: make one from the room number or name, the same way the screens do.
    code = spaceCodeFrom({ roomNumber: values.roomNumber ?? null, spaceName: values.spaceName, buildingCode: building?.buildingCode ?? null }, new Set([...lookups.taken, ...seen]));
  }
  if (code) seen.add(code);

  if (issues.length > 0 || !type || !values.spaceName) return { issues, insert: null };
  return {
    issues,
    insert: {
      locationId,
      buildingId: building?._id ?? null,
      floorId: floor?._id ?? null,
      spaceTypeId: type._id,
      spaceCode: code,
      spaceName: values.spaceName,
      roomNumber: values.roomNumber ?? null,
      physicalCapacity: caps.physicalCapacity as number | null,
      academicCapacity: caps.academicCapacity as number | null,
      examCapacity: caps.examCapacity as number | null,
      schedulableOverride: null,
      homeClassroomEligibleOverride: null,
      features,
      suitabilityOverrides: tags.length > 0 ? tags : null,
      status: 'ACTIVE',
    },
  };
}

// ───────────────────────────────────────────────────────────── validate all rows

async function validateImport(ctx: ServiceContext, doc: SpaceImportDoc): Promise<void> {
  const rows = await SpaceImportRow.find({ tenantId: ctx.tenantId, importId: doc._id }).sort({ rowNumber: 1 }).lean<SpaceImportRowDoc[]>();
  const lookups = await loadLookups(ctx, doc.locationId);
  const seen = new Set<string>();
  const ops = [];
  for (const row of rows) {
    // A row that was already imported keeps its result; its room's code is "taken" by itself and must not be flagged.
    if (row.status === 'IMPORTED') continue;
    const checked = checkRow(doc.locationId, valuesOf(doc, row), lookups, seen);
    ops.push({ updateOne: { filter: { _id: row._id, tenantId: ctx.tenantId, status: { $ne: 'IMPORTED' } }, update: { $set: { status: checked.issues.length === 0 ? 'READY' : 'NEEDS_ATTENTION', issues: checked.issues } } } });
  }
  if (ops.length > 0) await SpaceImportRow.bulkWrite(ops as never);
}

// ───────────────────────────────────────────────────────────── DTOs

async function toImportDTO(ctx: ServiceContext, doc: SpaceImportDoc): Promise<SpaceImportDTO> {
  const rows = await SpaceImportRow.find({ tenantId: ctx.tenantId, importId: doc._id }).select('status issues').lean<Pick<SpaceImportRowDoc, 'status' | 'issues'>[]>();
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const ready = count('READY');
  const needs = count('NEEDS_ATTENTION');
  const imported = count('IMPORTED');
  const groups = new Map<SpaceImportIssueCode, number>();
  for (const r of rows) for (const i of new Set(r.issues.map((x) => x.code))) groups.set(i, (groups.get(i) ?? 0) + 1);
  const n = (k: number) => k.toLocaleString('en-IN');
  return {
    importId: doc._id,
    locationId: doc.locationId,
    fileName: doc.fileName,
    status: doc.status,
    headers: doc.headers,
    mapping: doc.mapping ?? {},
    missingRequired: missingRequired(doc.mapping),
    rowCount: doc.rowCount,
    ready,
    needsAttention: needs,
    imported,
    message: `${n(doc.rowCount)} row${doc.rowCount === 1 ? '' : 's'}: ${n(ready)} ready, ${n(needs)} need${needs === 1 ? 's' : ''} attention${imported > 0 ? `, ${n(imported)} imported` : ''}`,
    issueGroups: [...groups.entries()].map(([code, c]) => ({ code, ...ISSUE_TEXT[code], count: c })).sort((a, b) => b.count - a.count),
    createdAt: toIso(doc.createdAt)!,
  };
}

async function loadImport(ctx: ServiceContext, id: string): Promise<SpaceImportDoc> {
  const doc = await SpaceImport.findOne({ _id: id, tenantId: ctx.tenantId }).lean<SpaceImportDoc>();
  if (!doc) throw AppError.notFound('Import not found.');
  await assertInScope(ctx, await spaceScope(ctx), doc.locationId, 'location', id);
  return doc;
}

// ───────────────────────────────────────────────────────────── routes' functions

export function spaceTemplateCsv(): string {
  return `\uFEFF${toCsv(
    ['Building', 'Floor', 'Room code', 'Room name', 'Room number', 'Type', 'Physical capacity', 'Seats for classes', 'Exam capacity', 'Features', 'Suitable for'],
    [
      ['Main Block', 'First', '101', 'Room 101', '101', 'Standard Classroom', 45, 40, 30, 'Whiteboard; Projector', 'General teaching'],
      ['Main Block', 'Ground', 'CHEM', 'Chemistry Lab', '', 'Chemistry Lab', 32, 30, '', 'Laboratory Benches', 'Chemistry practical'],
      ['', '', 'PLAY', 'Playground', '', 'Playground', '', '', '', '', 'Outdoor sports'],
    ],
  )}`;
}

export async function createSpaceImport(ctx: ServiceContext, file: { buffer: Buffer; originalname?: string } | undefined, fields: CreateSpaceImportFields): Promise<SpaceImportDTO> {
  if (!file || file.buffer.length === 0) throw new AppError('FILE_REQUIRED');
  if (file.buffer.includes(0)) throw new AppError('IMPORT_FILE_INVALID');
  if (!(await scanFile(file.buffer)).clean) throw new AppError('FILE_REJECTED');
  const [school, location, scope] = await Promise.all([requireSchool(ctx), loadLocation(ctx, fields.locationId), spaceScope(ctx)]);
  await assertInScope(ctx, scope, fields.locationId, 'location', fields.locationId);
  assertLocationWritable(location);
  const rows = parseCsv(file.buffer.toString('utf8'));
  if (rows.length < 2) throw new AppError('IMPORT_FILE_INVALID');
  const headers = rows[0]!.map((h) => h.trim());
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length) throw new AppError('IMPORT_FILE_INVALID', 'Every column needs its own name in the first row.');
  const body = rows.slice(1);
  if (body.length > SPACE_IMPORT_MAX_ROWS) throw new AppError('IMPORT_FILE_INVALID', `This file has more than ${SPACE_IMPORT_MAX_ROWS} rows. Split it into smaller files.`);
  const mapping = suggestSpaceMapping(headers);
  const fileHash = createHash('sha256').update(file.buffer).digest('hex');
  const name = (file.originalname ?? 'rooms.csv').replace(/[^\w .-]+/g, '_').slice(0, 120) || 'rooms.csv';

  const id = await withTransaction(async (db) => {
    const [doc] = await SpaceImport.create([{ tenantId: ctx.tenantId, schoolId: school._id, locationId: fields.locationId, fileName: name, fileHash, status: 'UPLOADED', headers, mapping, rowCount: body.length, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await SpaceImportRow.insertMany(body.map((cells, i) => ({ _id: randomUUID(), tenantId: ctx.tenantId, importId: doc!._id, rowNumber: i + 2, raw: Object.fromEntries(headers.map((h, c) => [h, cells[c] ?? ''])), status: 'NEEDS_ATTENTION', issues: [], spaceId: null })), { session: db });
    await recordSpaceAudit(ctx, db, { entityType: 'space_import', entityId: doc!._id, action: 'space_import.created', locationId: fields.locationId, metadata: { rows: body.length, fileHash } });
    return doc!._id;
  });
  const doc = await loadImport(ctx, id);
  if (missingRequired(doc.mapping).length === 0) {
    await validateImport(ctx, doc);
    await SpaceImport.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { status: 'CHECKED' } });
  }
  return toImportDTO(ctx, await loadImport(ctx, id));
}

export async function listSpaceImports(ctx: ServiceContext): Promise<SpaceImportDTO[]> {
  const scope = await spaceScope(ctx);
  const docs = await SpaceImport.find({ tenantId: ctx.tenantId, ...(scope.all ? {} : { locationId: { $in: scope.locationIds } }) }).sort({ createdAt: -1 }).limit(20).lean<SpaceImportDoc[]>();
  return Promise.all(docs.map((d) => toImportDTO(ctx, d)));
}

export async function getSpaceImport(ctx: ServiceContext, id: string): Promise<SpaceImportDTO> {
  return toImportDTO(ctx, await loadImport(ctx, id));
}

export async function mapSpaceImport(ctx: ServiceContext, id: string, data: MapSpaceImportData): Promise<SpaceImportDTO> {
  const doc = await loadImport(ctx, id);
  if (doc.status === 'COMMITTED') throw new AppError('SPACE_IMPORT_DONE');
  const mapping: SpaceImportDoc['mapping'] = {};
  const used = new Set<string>();
  for (const [field, header] of Object.entries(data.mapping) as [SpaceImportField, string | null | undefined][]) {
    if (!header) {
      mapping[field] = null;
      continue;
    }
    if (!doc.headers.includes(header)) throw AppError.validation({ [field]: 'This column is not in the file.' });
    if (used.has(header)) throw AppError.validation({ [field]: 'This column is already used for another field.' });
    used.add(header);
    mapping[field] = header;
  }
  const missing = missingRequired(mapping);
  const updated = { ...doc, mapping, status: missing.length === 0 ? ('CHECKED' as const) : ('UPLOADED' as const) };
  await SpaceImport.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { mapping, status: updated.status, updatedBy: ctx.userId } });
  if (missing.length === 0) await validateImport(ctx, updated);
  return toImportDTO(ctx, await loadImport(ctx, id));
}

export async function listSpaceImportRows(ctx: ServiceContext, id: string, query: SpaceImportRowsQuery): Promise<SpaceImportRowListDTO> {
  const doc = await loadImport(ctx, id);
  const filter = { tenantId: ctx.tenantId, importId: id, ...(query.status ? { status: query.status } : {}) };
  const [rows, total] = await Promise.all([SpaceImportRow.find(filter).sort({ rowNumber: 1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<SpaceImportRowDoc[]>(), SpaceImportRow.countDocuments(filter)]);
  const items: SpaceImportRowDTO[] = rows.map((r) => ({ rowId: r._id, rowNumber: r.rowNumber, status: r.status, values: valuesOf(doc, r), issues: r.issues.map((i) => ({ code: i.code, field: i.field, ...ISSUE_TEXT[i.code] })), spaceId: r.spaceId ?? null }));
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/** Imports the READY rows. Safe to run again: imported rows are skipped, and two commits at once cannot claim the same row. */
export async function commitSpaceImport(ctx: ServiceContext, id: string): Promise<SpaceImportCommitDTO> {
  const doc = await loadImport(ctx, id);
  if (missingRequired(doc.mapping).length > 0) throw new AppError('SPACE_IMPORT_MAPPING_INCOMPLETE');
  if (doc.status === 'UPLOADED') throw new AppError('SPACE_IMPORT_NOT_READY');
  const [rows, lookups] = await Promise.all([SpaceImportRow.find({ tenantId: ctx.tenantId, importId: id, status: 'READY' }).sort({ rowNumber: 1 }).lean<SpaceImportRowDoc[]>(), loadLookups(ctx, doc.locationId)]);
  const already = await SpaceImportRow.countDocuments({ tenantId: ctx.tenantId, importId: id, status: 'IMPORTED' });
  let imported = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    const checked = checkRow(doc.locationId, valuesOf(doc, row), lookups, seen);
    if (!checked.insert) {
      await SpaceImportRow.updateOne({ _id: row._id, tenantId: ctx.tenantId, status: 'READY' }, { $set: { status: 'NEEDS_ATTENTION', issues: checked.issues } });
      skipped += 1;
      continue;
    }
    try {
      const claimed = await withTransaction(async (db) => {
        // Claim the row first: if another commit got it, this one does nothing.
        const claim = await SpaceImportRow.findOneAndUpdate({ _id: row._id, tenantId: ctx.tenantId, status: 'READY' }, { $set: { status: 'IMPORTED' } }, { session: db, returnDocument: 'after' }).lean();
        if (!claim) return false;
        const [space] = await insertSpaces(ctx, db, [checked.insert!], 'import');
        await SpaceImportRow.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { spaceId: space!._id } }, { session: db });
        return true;
      });
      if (claimed) {
        imported += 1;
        lookups.taken.add(checked.insert.spaceCode ?? '');
      }
    } catch (err) {
      if (!(err instanceof AppError) && !(typeof err === 'object' && err && (err as { code?: number }).code === 11000)) throw err;
      await SpaceImportRow.updateOne({ _id: row._id, tenantId: ctx.tenantId, status: 'READY' }, { $set: { status: 'NEEDS_ATTENTION', issues: [{ code: 'CODE_TAKEN', field: 'spaceCode' }] } });
      skipped += 1;
    }
  }
  await withTransaction(async (db) => {
    await SpaceImport.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { status: 'COMMITTED', updatedBy: ctx.userId } }, { session: db });
    await recordSpaceAudit(ctx, db, { entityType: 'space_import', entityId: id, action: 'space_import.committed', locationId: doc.locationId, metadata: { imported, skipped, alreadyImported: already } });
  });
  const result = await toImportDTO(ctx, await loadImport(ctx, id));
  return { imported, skipped, alreadyImported: already, message: imported === 0 && already > 0 ? 'Everything in this file was already imported.' : `${imported} room${imported === 1 ? '' : 's'} imported${skipped > 0 ? `, ${skipped} left out because they need attention` : ''}.`, import: result };
}
