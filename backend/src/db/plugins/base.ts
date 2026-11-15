import { randomUUID } from 'node:crypto';

/** Permanent UUID primary key (PRD §4: UUID PKs, never labels or incremental ids). */
export const uuidPrimaryKey = {
  _id: { type: String, default: () => randomUUID() },
} as const;

/** Canonical audit columns (PRD §4). `createdAt/updatedAt` come from `timestamps`. */
export const auditFields = {
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null },
  archivedAt: { type: Date, default: null },
  archivedBy: { type: String, default: null },
} as const;

export interface BaseDoc {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditFields {
  createdBy: string | null;
  updatedBy: string | null;
  archivedAt: Date | null;
  archivedBy: string | null;
}

export function baseSchemaOptions(collection: string) {
  return {
    collection,
    timestamps: true,
    versionKey: false,
    id: false,
    strict: true,
  } as const;
}
