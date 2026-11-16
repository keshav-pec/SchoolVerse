import type { RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from './errors';

/**
 * Single-file, in-memory upload for small images (the bytes are sniffed and then handed to the
 * storage adapter). Multer errors become catalog errors.
 */
export function singleImageUpload(field: string, maxBytes: number): RequestHandler {
  const handler = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1, fields: 5 } }).single(field);
  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError('FILE_TOO_LARGE', undefined, { fields: { [field]: 'This file is too large. The maximum size is 2 MB.' } }));
        }
        return next(new AppError('VALIDATION_FAILED', undefined, { fields: { [field]: 'Upload exactly one image file.' } }));
      }
      return next(err);
    });
  };
}

/**
 * Single-file, in-memory upload for documents, with the text fields that travel beside the file. Unlike an image upload it
 * must run AFTER the authorization checks, so a caller who may not upload never gets a file buffered.
 */
export function singleDocumentUpload(field: string, maxBytes: number): RequestHandler {
  const handler = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1, fields: 5, fieldSize: 500 } }).single(field);
  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError('DOCUMENT_TOO_LARGE'));
        return next(new AppError('VALIDATION_FAILED', undefined, { fields: { [field]: 'Upload exactly one file.' } }));
      }
      return next(err);
    });
  };
}
