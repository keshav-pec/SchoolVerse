import { Schema, model } from 'mongoose';
import { baseSchemaOptions, uuidPrimaryKey, type BaseDoc } from '../../../db/plugins/base';
import { tenantScopePlugin } from '../../../db/plugins/tenant-scope';
import { immutablePlugin } from '../core/immutable';

/**
 * Module 7, Part 3B. A bank statement is evidence, kept exactly as it was uploaded. Its lines are never edited: matching only adds
 * a link, an ignore reason or a status. Every row stores tenant, school and legal entity.
 */

const common = {
  tenantId: { type: String, required: true, immutable: true },
  schoolId: { type: String, required: true, immutable: true },
  legalEntityId: { type: String, required: true, immutable: true },
} as const;
interface FinanceCommon {
  tenantId: string;
  schoolId: string;
  legalEntityId: string;
}

export const LINE_STATUSES = ['UNMATCHED', 'SUGGESTED', 'AUTO_MATCHED', 'VERIFIED_MATCHED', 'PARTIAL', 'DUPLICATE_SUSPECTED', 'VARIANCE', 'IGNORED'] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

export interface StatementMapping {
  date: string;
  description: string | null;
  reference: string | null;
  debit: string | null;
  credit: string | null;
  amount: string | null;
  balance: string | null;
}
const mappingShape = { date: String, description: { type: String, default: null }, reference: { type: String, default: null }, debit: { type: String, default: null }, credit: { type: String, default: null }, amount: { type: String, default: null }, balance: { type: String, default: null } };

export interface BankStatementMappingDoc extends BaseDoc, FinanceCommon {
  bankAccountId: string;
  mapping: StatementMapping;
}
const mappingSchema = new Schema<BankStatementMappingDoc>({ ...uuidPrimaryKey, ...common, bankAccountId: { type: String, required: true }, mapping: { type: new Schema(mappingShape, { _id: false }), required: true } }, baseSchemaOptions('bank_statement_mappings'));
mappingSchema.index({ tenantId: 1, bankAccountId: 1 }, { unique: true });
mappingSchema.plugin(tenantScopePlugin);
export const BankStatementMapping = model<BankStatementMappingDoc>('BankStatementMapping', mappingSchema);

export interface BankStatementImportDoc extends BaseDoc, FinanceCommon {
  bankAccountId: string;
  fileName: string;
  fileHash: string;
  fileKey: string;
  mapping: StatementMapping;
  rowCount: number;
  keptCount: number;
  skippedCount: number;
  creditsPaise: number;
  debitsPaise: number;
  openingPaise: number | null;
  closingPaise: number | null;
  fromDate: string;
  toDate: string;
  importedBy: string;
}
const importSchema = new Schema<BankStatementImportDoc>(
  {
    ...uuidPrimaryKey, ...common,
    bankAccountId: { type: String, required: true },
    fileName: { type: String, required: true },
    fileHash: { type: String, required: true },
    fileKey: { type: String, required: true },
    mapping: { type: new Schema(mappingShape, { _id: false }), required: true },
    rowCount: { type: Number, default: 0 },
    keptCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    creditsPaise: { type: Number, default: 0 },
    debitsPaise: { type: Number, default: 0 },
    openingPaise: { type: Number, default: null },
    closingPaise: { type: Number, default: null },
    fromDate: { type: String, required: true },
    toDate: { type: String, required: true },
    importedBy: { type: String, required: true },
  },
  baseSchemaOptions('bank_statement_imports'),
);
importSchema.index({ tenantId: 1, bankAccountId: 1, fileHash: 1 }, { unique: true });
importSchema.plugin(immutablePlugin);
importSchema.plugin(tenantScopePlugin);
export const BankStatementImport = model<BankStatementImportDoc>('BankStatementImport', importSchema);

export interface BankStatementLineDoc extends BaseDoc, FinanceCommon {
  importId: string;
  bankAccountId: string;
  lineNo: number;
  date: string;
  description: string;
  reference: string | null;
  referenceNorm: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number | null;
  fingerprint: string;
  occurrence: number;
  status: LineStatus;
  matchId: string | null;
  ignoredReason: string | null;
  postedJournalId: string | null;
  variancePaise: number;
}
const lineSchema = new Schema<BankStatementLineDoc>(
  {
    ...uuidPrimaryKey, ...common,
    importId: { type: String, required: true },
    bankAccountId: { type: String, required: true },
    lineNo: { type: Number, required: true },
    date: { type: String, required: true },
    description: { type: String, default: '' },
    reference: { type: String, default: null },
    referenceNorm: { type: String, default: null },
    debitPaise: { type: Number, default: 0 },
    creditPaise: { type: Number, default: 0 },
    balancePaise: { type: Number, default: null },
    fingerprint: { type: String, required: true },
    occurrence: { type: Number, required: true },
    status: { type: String, enum: LINE_STATUSES, default: 'UNMATCHED' },
    matchId: { type: String, default: null },
    ignoredReason: { type: String, default: null },
    postedJournalId: { type: String, default: null },
    variancePaise: { type: Number, default: 0 },
  },
  baseSchemaOptions('bank_statement_lines'),
);
lineSchema.index({ tenantId: 1, bankAccountId: 1, fingerprint: 1, occurrence: 1 }, { unique: true });
lineSchema.index({ tenantId: 1, bankAccountId: 1, status: 1, date: 1 });
lineSchema.index({ tenantId: 1, importId: 1, lineNo: 1 });
lineSchema.plugin(tenantScopePlugin);
export const BankStatementLine = model<BankStatementLineDoc>('BankStatementLine', lineSchema);

export interface MatchTarget {
  type: string;
  id: string;
  amountPaise: number;
}
export interface ReconciliationMatchDoc extends BaseDoc, FinanceCommon {
  bankAccountId: string;
  lineIds: string[];
  targets: MatchTarget[];
  linesPaise: number;
  targetsPaise: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'MANUAL';
  reasons: string[];
  state: 'SUGGESTED' | 'CONFIRMED' | 'REVERSED' | 'REJECTED';
  auto: boolean;
  needsVerification: boolean;
  approvalId: string | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  reversedBy: string | null;
  reversedReason: string | null;
}
const matchSchema = new Schema<ReconciliationMatchDoc>(
  {
    ...uuidPrimaryKey, ...common,
    bankAccountId: { type: String, required: true },
    lineIds: { type: [String], default: [] },
    targets: { type: [new Schema({ type: String, id: String, amountPaise: Number }, { _id: false })], default: [] },
    linesPaise: { type: Number, default: 0 },
    targetsPaise: { type: Number, default: 0 },
    confidence: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW', 'MANUAL'], required: true },
    reasons: { type: [String], default: [] },
    state: { type: String, enum: ['SUGGESTED', 'CONFIRMED', 'REVERSED', 'REJECTED'], default: 'SUGGESTED' },
    auto: { type: Boolean, default: false },
    needsVerification: { type: Boolean, default: false },
    approvalId: { type: String, default: null },
    confirmedBy: { type: String, default: null },
    confirmedAt: { type: Date, default: null },
    reversedBy: { type: String, default: null },
    reversedReason: { type: String, default: null },
  },
  baseSchemaOptions('reconciliation_matches'),
);
matchSchema.index({ tenantId: 1, bankAccountId: 1, state: 1 });
matchSchema.index({ tenantId: 1, lineIds: 1 });
matchSchema.plugin(tenantScopePlugin);
export const ReconciliationMatch = model<ReconciliationMatchDoc>('ReconciliationMatch', matchSchema);
