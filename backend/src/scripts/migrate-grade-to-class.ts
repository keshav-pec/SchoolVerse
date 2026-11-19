/**
 * One-off data migration for the Grade → Class rename. Moves existing data to the new names without reseeding:
 *
 *  - collections  `grade_offerings` → `class_offerings`, `grade_master` → `class_master`
 *  - fields       `gradeId` → `classId`, `gradeOfferingId` → `classOfferingId`, `gradeFromId`/`gradeToId` → `classFromId`/`classToId`,
 *                 `isBoardGrade` → `isBoardClass`
 *  - names        the class master's "Grade N" → "Class N", and class offerings still using that default name
 *  - indexes      old indexes on grade fields are dropped and the schema's indexes rebuilt
 *  - audit trail  entity type / action `grade_offering` → `class_offering`, grade field names in `changes` and `metadata`.
 *                 Old values (such as a from/to "Grade 8") are history and stay as they were.
 *
 * Before changing a collection it copies it to `<name>__bak_grade_to_class`. Safe to re-run: it does nothing once
 * the data is migrated, and refuses to overwrite an existing backup.
 *
 *   npm run migrate:grade-to-class -- --dry-run   # report only
 *   npm run migrate:grade-to-class
 */
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { connectDatabase, disconnectDatabase } from '../db/connection';
import { ClassOffering, SectionOffering, SubjectOffering } from '../modules/academic/offering.model';
import { ClassMaster } from '../modules/academic/reference.model';
import { AcademicProgramme, SubjectChoiceConstraint, SubjectChoiceGroup } from '../modules/academic/rules.model';
import { AcademicAssignment } from '../modules/staff/assignment.models';

// The driver types bundled with Mongoose (the project also has its own `mongodb`, whose types don't match).
type Db = mongoose.mongo.Db;
type Collection = mongoose.mongo.Collection;
type Document = mongoose.mongo.Document;
type AnyBulkWriteOperation<T extends Document> = mongoose.mongo.AnyBulkWriteOperation<T>;

const DRY = process.argv.includes('--dry-run');
const BACKUP_SUFFIX = '__bak_grade_to_class';

const COLLECTION_RENAMES: [string, string][] = [
  ['grade_offerings', 'class_offerings'],
  ['grade_master', 'class_master'],
];

const FIELD_RENAMES: Record<string, Record<string, string>> = {
  class_offerings: { gradeId: 'classId' },
  class_master: { isBoardGrade: 'isBoardClass' },
  section_offerings: { gradeOfferingId: 'classOfferingId' },
  subject_offerings: { gradeOfferingId: 'classOfferingId' },
  subject_choice_groups: { gradeOfferingId: 'classOfferingId' },
  subject_choice_constraints: { gradeOfferingId: 'classOfferingId' },
  academic_programmes: { gradeFromId: 'classFromId', gradeToId: 'classToId' },
  faculty_academic_assignments: { gradeOfferingId: 'classOfferingId' },
};

const MODELS = [ClassOffering, ClassMaster, SectionOffering, SubjectOffering, SubjectChoiceGroup, SubjectChoiceConstraint, AcademicProgramme, AcademicAssignment];

/** Same mapping the code rename used: a lone `grade` is `schoolClass` (`class` is reserved), `gradeName` avoids React's `className`. */
const SPECIAL: Record<string, string> = { grade: 'schoolClass', Grade: 'SchoolClass', gradeName: 'schoolClassName', grades: 'classes' };
export const renameIdentifier = (s: string) =>
  SPECIAL[s] ??
  s
    .replace(/GRADES/g, 'CLASSES')
    .replace(/GRADE/g, 'CLASS')
    .replace(/Grades/g, 'Classes')
    .replace(/Grade/g, 'Class')
    .replace(/grades/g, 'classes')
    .replace(/grade/g, 'class');

/** Keys always; string values only when they are codes (no spaces), e.g. `grade_offering` — prose values are history. */
export function renameDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameDeep);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [/grade/i.test(k) ? renameIdentifier(k) : k, renameDeep(v)]));
  }
  if (typeof value === 'string' && /grade/i.test(value) && /^[\w.:-]+$/.test(value)) return renameIdentifier(value);
  return value;
}

const GRADE_NAME = /^Grade (\d{1,2})$/;
const log = (msg: string) => console.log(`${DRY ? '[dry-run] ' : ''}${msg}`);

async function exists(db: Db, name: string) {
  return (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
}

const backedUp = new Set<string>();
async function backup(db: Db, name: string) {
  if (DRY || backedUp.has(name) || !(await exists(db, name))) return;
  const target = name + BACKUP_SUFFIX;
  if (await exists(db, target)) throw new Error(`Backup ${target} already exists. Check it and drop it before re-running.`);
  await db.collection(name).aggregate([{ $match: {} }, { $out: target }]).toArray();
  backedUp.add(name);
  log(`backed up ${name} → ${target}`);
}

async function renameCollections(db: Db) {
  for (const [from, to] of COLLECTION_RENAMES) {
    const hasFrom = await exists(db, from);
    const hasTo = await exists(db, to);
    if (!hasFrom) {
      log(`${from}: not found${hasTo ? ' (already migrated)' : ''}`);
      continue;
    }
    const fromCount = await db.collection(from).countDocuments();
    if (hasTo) {
      const toCount = await db.collection(to).countDocuments();
      if (toCount > 0) throw new Error(`Both ${from} (${fromCount}) and ${to} (${toCount}) hold documents. Merge them by hand.`);
      // The new code (Mongoose autoCreate) made an empty `to` when the server started; it can go.
      log(`${to}: empty collection created by the new code, dropping it`);
      if (!DRY) await db.collection(to).drop();
    }
    log(`rename collection ${from} (${fromCount} docs) → ${to}`);
    if (!DRY) {
      await backup(db, from);
      await db.collection(from).rename(to);
    }
  }
}

async function dropGradeIndexes(coll: Collection) {
  for (const index of await coll.indexes()) {
    if (Object.keys(index.key).some((k) => /grade/i.test(k)) && index.name) {
      log(`${coll.collectionName}: drop index ${index.name}`);
      if (!DRY) await coll.dropIndex(index.name);
    }
  }
}

async function renameFields(db: Db) {
  // In a dry run the collections are not renamed yet, so read from the old name.
  const source = (name: string) => (DRY ? COLLECTION_RENAMES.find(([, to]) => to === name)?.[0] ?? name : name);
  for (const [name, fields] of Object.entries(FIELD_RENAMES)) {
    const collName = source(name);
    if (!(await exists(db, collName))) continue;
    const coll = db.collection(collName);
    const filter = { $or: Object.keys(fields).map((f) => ({ [f]: { $exists: true } })) };
    const count = await coll.countDocuments(filter);
    // Drop first: once a field is renamed, a unique index on the old one sees every row as null and blocks the update.
    await dropGradeIndexes(coll);
    if (count === 0) continue;
    log(`${name}: rename ${Object.entries(fields).map(([a, b]) => `${a}→${b}`).join(', ')} on ${count} docs`);
    if (!DRY) {
      await backup(db, name);
      await coll.updateMany(filter, { $rename: fields });
    }
  }
}

async function renameDefaultNames(db: Db) {
  // In a dry run the collections are not renamed yet.
  const master = db.collection(DRY && (await exists(db, 'grade_master')) ? 'grade_master' : 'class_master');
  const offerings = db.collection(DRY && (await exists(db, 'grade_offerings')) ? 'grade_offerings' : 'class_offerings');
  for (const [coll, field] of [
    [master, 'canonicalName'],
    [offerings, 'displayName'],
  ] as const) {
    const docs = await coll.find({ [field]: GRADE_NAME }).project({ [field]: 1 }).toArray();
    if (docs.length === 0) continue;
    log(`${coll.collectionName}: ${field} "Grade N" → "Class N" on ${docs.length} docs`);
    if (!DRY) {
      await backup(db, coll.collectionName);
      await coll.bulkWrite(
        docs.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { [field]: String(d[field]).replace(GRADE_NAME, 'Class $1') } } } })),
      );
    }
  }
}

async function migrateAudit(db: Db) {
  if (!(await exists(db, 'audit_events'))) return;
  // Raw driver: the AuditEvent model is append-only by design.
  const coll = db.collection('audit_events');
  const ops: AnyBulkWriteOperation<Document>[] = [];
  for await (const doc of coll.find({}, { projection: { entityType: 1, action: 1, changes: 1, metadata: 1 } })) {
    const set: Record<string, unknown> = {};
    if (typeof doc.entityType === 'string' && /grade/i.test(doc.entityType)) set.entityType = renameIdentifier(doc.entityType);
    if (typeof doc.action === 'string' && /grade/i.test(doc.action)) set.action = renameIdentifier(doc.action);
    if (Array.isArray(doc.changes) && doc.changes.some((c: { field?: string }) => /grade/i.test(c.field ?? ''))) {
      set.changes = doc.changes.map((c: { field: string }) => ({ ...c, field: renameIdentifier(c.field) }));
    }
    if (doc.metadata) {
      const metadata = renameDeep(doc.metadata);
      if (JSON.stringify(metadata) !== JSON.stringify(doc.metadata)) set.metadata = metadata;
    }
    if (Object.keys(set).length > 0) ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
  }
  log(`audit_events: ${ops.length} events to update`);
  if (DRY || ops.length === 0) return;
  await backup(db, 'audit_events');
  for (let i = 0; i < ops.length; i += 500) await coll.bulkWrite(ops.slice(i, i + 500), { ordered: false });
}

async function main() {
  // No collections or indexes from the imported models until the data is in place (and none at all in a dry run).
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
  await connectDatabase(env.MONGODB_URI);
  const db = mongoose.connection.db!;
  log(`database: ${db.databaseName}`);

  await renameCollections(db);
  await renameFields(db);
  await renameDefaultNames(db);
  await migrateAudit(db);

  if (!DRY) {
    for (const model of MODELS) await model.createIndexes();
    log('indexes rebuilt from the schemas');
  }
  log('done');
  await disconnectDatabase();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error(err);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
}
