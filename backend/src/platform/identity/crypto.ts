import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';

/**
 * Field encryption and signed links (PRD §14, §15, §18). `node:crypto` only.
 *
 *   encryptField   AES-256-GCM, stored as `kid:iv:tag:ciphertext` (base64url parts).
 *   decryptField   finds the key by `kid`, so old values still open after a rotation.
 *   mask           what a restricted value looks like to everyone who has not revealed it.
 *   signFileToken  a short-lived HMAC link payload; `verifyFileToken` checks the signature and the expiry.
 *
 * A KMS can replace the env keys later behind this same file.
 */

const KEY_BYTES = 32;

export interface FieldCrypto {
  /** `context` ties a value to its owner (for example the person), so a ciphertext copied elsewhere does not decrypt. */
  encryptField(plain: string, context?: string): string;
  decryptField(stored: string, context?: string): string;
}

/** Parses `v2:<base64>,v1:<base64>` (newest first). */
export function parseFieldKeys(raw: string): { kid: string; key: Buffer }[] {
  const keys = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf(':');
      const kid = part.slice(0, at);
      const key = Buffer.from(part.slice(at + 1), 'base64');
      if (at < 1 || !/^[A-Za-z0-9_-]{1,16}$/.test(kid)) throw new Error('FIELD_ENCRYPTION_KEYS entries look like "v1:<base64 key>".');
      if (key.length !== KEY_BYTES) throw new Error(`Encryption key "${kid}" must be ${KEY_BYTES} bytes.`);
      return { kid, key };
    });
  if (keys.length === 0) throw new Error('FIELD_ENCRYPTION_KEYS is empty.');
  if (new Set(keys.map((k) => k.kid)).size !== keys.length) throw new Error('FIELD_ENCRYPTION_KEYS repeats a key id.');
  return keys;
}

export function createFieldCrypto(rawKeys: string): FieldCrypto {
  const keys = parseFieldKeys(rawKeys);
  const current = keys[0]!;
  const byId = new Map(keys.map((k) => [k.kid, k.key]));
  const b64 = (buf: Buffer) => buf.toString('base64url');

  return {
    encryptField(plain, context = '') {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', current.key, iv);
      cipher.setAAD(Buffer.from(context));
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return [current.kid, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(':');
    },
    decryptField(stored, context = '') {
      const [kid, iv, tag, ct] = stored.split(':');
      const key = kid ? byId.get(kid) : undefined;
      if (!key || !iv || !tag || ct === undefined) throw new Error('Unreadable encrypted value.');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}

const fieldCrypto = createFieldCrypto(env.FIELD_ENCRYPTION_KEYS);
export const encryptField = fieldCrypto.encryptField;
export const decryptField = fieldCrypto.decryptField;

// ───────────────────────────────────────────────────────────── masks

export type MaskKind = 'DATE_OF_BIRTH' | 'GOVERNMENT_ID' | 'BANK_ACCOUNT';

export const last4 = (value: string) => value.slice(-4);

/**
 * `DATE_OF_BIRTH` takes `YYYY-MM-DD` and keeps the year. The others only need the last four characters, so they work on
 * the full value or on the stored `last4`.
 */
export function mask(value: string, kind: MaskKind): string {
  if (kind === 'DATE_OF_BIRTH') return `••/••/${value.slice(0, 4)}`;
  if (kind === 'GOVERNMENT_ID') return `XXXX XXXX ${last4(value)}`;
  return `•••• ${last4(value)}`;
}

// ───────────────────────────────────────────────────────────── signed links

export interface FileTokenPayload {
  /** Private storage key. */
  k: string;
  /** MIME type to send. */
  m: string;
  /** Download name. */
  n: string;
  /** Tenant, so a link can never be replayed against another tenant's file. */
  t: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const sign = (body: string) => createHmac('sha256', env.FILE_URL_SECRET).update(body).digest('base64url');

export function signFileToken(payload: Omit<FileTokenPayload, 'exp'>, ttlSeconds: number, now = Date.now()): { token: string; expiresAt: Date } {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  return { token: `${body}.${sign(body)}`, expiresAt: new Date(exp * 1000) };
}

/** Returns the payload, or `null` for a tampered, malformed or expired token (one answer for all three). */
export function verifyFileToken(token: string, now = Date.now()): FileTokenPayload | null {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as FileTokenPayload;
    if (typeof payload.k !== 'string' || typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}
