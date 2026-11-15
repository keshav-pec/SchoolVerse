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
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\n✖ Invalid environment configuration:\n${lines}\n\nSee backend/.env.example\n`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
