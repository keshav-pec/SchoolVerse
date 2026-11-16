import path from 'node:path';
import { z } from 'zod';

/**
 * Loads `apps/api/.env` (or the repo-root `.env`) if present, then validates.
 * The process fails fast with a readable message when configuration is invalid.
 */
function loadEnvFiles() {
  const candidates = [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')];
  for (const file of candidates) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // file missing — try the next candidate
    }
  }
}

if (process.env.NODE_ENV !== 'test') loadEnvFiles();

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().default(''),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  WEB_ORIGIN: z.string().url().default('http://localhost:5180'),
  COOKIE_SECURE: booleanish.default(false),
  /** Local folder for uploaded files (school logos). Swap the storage adapter for S3 later. */
  UPLOAD_DIR: z.string().min(1).default('uploads'),
  /**
   * Field-encryption keys, newest first: `v2:<base64 32 bytes>,v1:<base64 32 bytes>`. The first key encrypts, every key
   * can decrypt, so a key is rotated by putting a new one in front. Required in production.
   */
  FIELD_ENCRYPTION_KEYS: z.string().optional(),
  /** Signs download links (documents and exports). At least 32 characters. Required in production. */
  FILE_URL_SECRET: z.string().min(32, 'FILE_URL_SECRET must be at least 32 characters').optional(),
  /** Private files (employee documents, exports). Never served statically. */
  PRIVATE_UPLOAD_DIR: z.string().min(1).default('private-uploads'),
  /** Public address of the web app, used in activation and reset links. Defaults to WEB_ORIGIN. */
  APP_BASE_URL: z.string().url().optional(),
  /** Writes emails to the `dev_outbox` collection and serves them at /api/v1/dev/outbox. Off in production unless set. */
  DEV_OUTBOX: booleanish.optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\n✖ Invalid environment configuration:\n${lines}\n\nSee backend/.env.example\n`);
  process.exit(1);
}

const isProduction = parsed.data.NODE_ENV === 'production';

// Production never runs on the built-in development keys.
if (isProduction && (!parsed.data.FIELD_ENCRYPTION_KEYS || !parsed.data.FILE_URL_SECRET)) {
  console.error('\n✖ Invalid environment configuration:\n  • FIELD_ENCRYPTION_KEYS and FILE_URL_SECRET are required in production.\n\nSee backend/.env.example\n');
  process.exit(1);
}

/** Development and test fall back to fixed keys so the app runs with no setup. They protect nothing real. */
const DEV_FIELD_KEYS = `dev1:${Buffer.alloc(32, 'schoolverse-dev-field-key').toString('base64')}`;
const DEV_FILE_SECRET = 'schoolverse-dev-file-url-secret-0123456789';

export const env = {
  ...parsed.data,
  FIELD_ENCRYPTION_KEYS: parsed.data.FIELD_ENCRYPTION_KEYS ?? DEV_FIELD_KEYS,
  FILE_URL_SECRET: parsed.data.FILE_URL_SECRET ?? DEV_FILE_SECRET,
  APP_BASE_URL: (parsed.data.APP_BASE_URL ?? parsed.data.WEB_ORIGIN).replace(/\/+$/, ''),
  DEV_OUTBOX: parsed.data.DEV_OUTBOX ?? !isProduction,
};
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
