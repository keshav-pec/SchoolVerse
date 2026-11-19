import { Schema, model } from 'mongoose';
import { baseSchemaOptions, type BaseDoc } from '../../db/plugins/base';

export interface StoredFileDoc extends BaseDoc {
  /** The storage key, e.g. `<tenantId>/school-logos/<id>.png`. Server-generated only. */
  _id: string;
  contentType: string;
  size: number;
  data: Buffer;
}

/**
 * Public images (school logos) kept in the database so they survive redeploys and are the same in every environment.
 * Not tenant-scoped on purpose: files are read by their unguessable key over /uploads, with no session.
 */
const storedFileSchema = new Schema<StoredFileDoc>(
  {
    _id: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true },
  },
  baseSchemaOptions('stored_files'),
);

export const StoredFile = model<StoredFileDoc>('StoredFile', storedFileSchema);
