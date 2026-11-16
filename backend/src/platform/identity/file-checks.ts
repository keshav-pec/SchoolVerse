import type { DocumentMimeType } from '@shared';

/**
 * Document uploads (PRD §18): the type comes from the file's own bytes, never from the client's MIME type or extension.
 * Only PDF, PNG and JPEG are accepted. SVG, HTML and Office files can carry scripts, so they are not.
 */
export function sniffDocumentType(buf: Buffer): DocumentMimeType | null {
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

export type ScanResult = { clean: true } | { clean: false; reason: string };
export type FileScanner = (body: Buffer) => Promise<ScanResult>;

/** The standard antivirus test string. Every scanner must flag it, and it is harmless, so tests and demos use it. */
export const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const defaultScanner: FileScanner = async (body) =>
  body.includes(EICAR_SIGNATURE) ? { clean: false, reason: 'EICAR' } : { clean: true };

let scanner: FileScanner = defaultScanner;

/** Swap in ClamAV or a cloud scanner later without touching callers. */
export function setFileScanner(next: FileScanner | null) {
  scanner = next ?? defaultScanner;
}

export const scanFile: FileScanner = (body) => scanner(body);

/** A name that is safe in a `Content-Disposition` header and on disk listings. */
export function safeFileName(name: string, fallback = 'download'): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\/:*?"<>|\r\n\t;]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}
