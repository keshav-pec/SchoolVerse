import type { Schema } from 'mongoose';
import { AppError } from '../../../core/errors';

/**
 * A record that can never change after it is saved (journals, issued bill lines, ledger rows, receipts, payslips). A mistake is
 * fixed with a NEW linked record (a reversing journal, a credit note), never by editing this one. Enforced in the model, so no
 * service, script or route can update or delete one by accident. Register it BEFORE the tenant plugin so this error comes first.
 */
export function immutablePlugin(schema: Schema) {
  const refuse = () => {
    throw new AppError('IMMUTABLE_RECORD');
  };
  schema.pre('save', function () {
    if (!this.isNew) refuse();
  });
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'], refuse);
  schema.pre('deleteOne', { document: true, query: false }, refuse);
  schema.pre('bulkWrite', refuse);
}
