import type { ClientSession } from 'mongoose';
import type { BankDetailsData, GovernmentIdType, RestrictedEmployeeProfileDTO, RestrictedField } from '@shared';
import { toIso } from '../../core/objects';
import { decryptField, encryptField, last4, mask } from './crypto';
import { RestrictedPersonData, type BankEntry, type GovernmentIdEntry, type RestrictedPersonDataDoc } from './restricted-data.model';

/**
 * Everything that reads or writes `restricted_person_data` lives here: sealing, masking, revealing, merging. The encryption
 * context ties each ciphertext to its person and field, so a value copied to another row does not decrypt.
 */

const idContext = (personId: string, type: GovernmentIdType) => `${personId}:id:${type}`;
const bankContext = (personId: string) => `${personId}:bank`;

export function sealGovernmentId(personId: string, type: GovernmentIdType, value: string): GovernmentIdEntry {
  return { type, valueEnc: encryptField(value, idContext(personId, type)), last4: last4(value) };
}

export function sealBank(personId: string, bank: BankDetailsData): BankEntry {
  return {
    accountHolderName: bank.accountHolderName,
    accountNumberEnc: encryptField(bank.accountNumber, bankContext(personId)),
    last4: last4(bank.accountNumber),
    ifsc: bank.ifsc,
    bankName: bank.bankName,
  };
}

export async function findRestricted(tenantId: string, personId: string, db?: ClientSession) {
  return RestrictedPersonData.findOne({ tenantId, personId }).session(db ?? null).lean<RestrictedPersonDataDoc>();
}

/** Always masked. `dateOfBirth` is `YYYY-MM-DD` from the person record. */
export function toRestrictedDTO(ids: { employeeId: string; personId: string }, doc: RestrictedPersonDataDoc | null, dateOfBirth: string | null): RestrictedEmployeeProfileDTO {
  return {
    employeeId: ids.employeeId,
    personId: ids.personId,
    dateOfBirth: dateOfBirth ? { masked: mask(dateOfBirth, 'DATE_OF_BIRTH') } : null,
    governmentIds: (doc?.governmentIds ?? []).map((g) => ({ type: g.type, masked: mask(g.last4, 'GOVERNMENT_ID') })),
    bank: doc?.bank
      ? { accountHolderName: doc.bank.accountHolderName, accountNumberMasked: mask(doc.bank.last4, 'BANK_ACCOUNT'), ifsc: doc.bank.ifsc, bankName: doc.bank.bankName }
      : null,
    updatedAt: toIso(doc?.updatedAt),
  };
}

/** The one place a stored value is turned back into plain text. Callers must have checked permission and step-up. */
export function readValue(personId: string, doc: RestrictedPersonDataDoc | null, dateOfBirth: string | null, field: RestrictedField): string | null {
  if (field === 'DATE_OF_BIRTH') return dateOfBirth;
  if (field === 'BANK_ACCOUNT_NUMBER') return doc?.bank ? decryptField(doc.bank.accountNumberEnc, bankContext(personId)) : null;
  const entry = doc?.governmentIds.find((g) => g.type === field);
  return entry ? decryptField(entry.valueEnc, idContext(personId, entry.type)) : null;
}

/** Adds or replaces each ID by type; `value: null` removes it. */
export function mergeGovernmentIds(personId: string, existing: readonly GovernmentIdEntry[], updates: readonly { type: GovernmentIdType; value: string | null }[]): GovernmentIdEntry[] {
  const byType = new Map(existing.map((g) => [g.type, g]));
  for (const update of updates) {
    if (update.value === null) byType.delete(update.type);
    else byType.set(update.type, sealGovernmentId(personId, update.type, update.value));
  }
  return [...byType.values()];
}

export interface RestrictedPatch {
  governmentIds?: readonly { type: GovernmentIdType; value: string | null }[];
  /** `null` removes the bank details. */
  bank?: BankDetailsData | null;
}

/** Creates the row on first use. Pass the caller's transaction. */
export async function saveRestricted(tenantId: string, personId: string, patch: RestrictedPatch, actorId: string | null, db: ClientSession) {
  const existing = await findRestricted(tenantId, personId, db);
  const governmentIds = patch.governmentIds ? mergeGovernmentIds(personId, existing?.governmentIds ?? [], patch.governmentIds) : (existing?.governmentIds ?? []);
  const bank = patch.bank === undefined ? (existing?.bank ?? null) : patch.bank === null ? null : sealBank(personId, patch.bank);
  if (existing) {
    await RestrictedPersonData.updateOne({ _id: existing._id, tenantId }, { $set: { governmentIds, bank, updatedBy: actorId } }, { session: db });
  } else {
    await RestrictedPersonData.create([{ tenantId, personId, governmentIds, bank, createdBy: actorId, updatedBy: actorId }], { session: db });
  }
}
