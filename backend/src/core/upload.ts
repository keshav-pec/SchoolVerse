import type { RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from './errors';

/** One in-memory file in `field`; multer errors become catalog errors. The bytes are sniffed later, never trusted. */
function singleFileUpload(field: string, limits: multer.Options['limits'], tooLarge: () => AppError, wrongCount: string): RequestHandler {
  const handler = multer({ storage: multer.memoryStorage(), limits: { files: 1, fields: 5, ...limits } }).single(field);
  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        return next(err.code === 'LIMIT_FILE_SIZE' ? tooLarge() : new AppError('VALIDATION_FAILED', undefined, { fields: { [field]: wrongCount } }));
      }
      return next(err);
    });
  };
}

/** A small image (school logo), handed to the storage adapter after sniffing. */
export function singleImageUpload(field: string, maxBytes: number): RequestHandler {
  return singleFileUpload(
    field,
    { fileSize: maxBytes },
    () => new AppError('FILE_TOO_LARGE', undefined, { fields: { [field]: 'This file is too large. The maximum size is 2 MB.' } }),
    'Upload exactly one image file.',
  );
}

/**
 * A document, with the text fields that travel beside the file. Unlike an image upload it must run AFTER the
 * authorization checks, so a caller who may not upload never gets a file buffered.
 */
export function singleDocumentUpload(field: string, maxBytes: number): RequestHandler {
  return singleFileUpload(field, { fileSize: maxBytes, fieldSize: 500 }, () => new AppError('DOCUMENT_TOO_LARGE'), 'Upload exactly one file.');
}

/** A CSV file (student import) with the text fields that travel beside it. The bytes are checked later; the type the browser claims is ignored. */
export function singleCsvUpload(field: string, maxBytes: number): RequestHandler {
  return singleFileUpload(field, { fileSize: maxBytes, fieldSize: 200 }, () => new AppError('FILE_TOO_LARGE'), 'Upload exactly one CSV file.');
}
