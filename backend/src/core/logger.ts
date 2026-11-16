import { pino } from 'pino';
import { env, isProd, isTest } from '../config/env';

/** Keys whose value must never reach a log line, wherever they sit in the logged object. */
const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'passwordHash',
  'token',
  'code',
  'value',
  'accountNumber',
  'governmentIds',
  'proposedValueEnc',
  'secret',
  'authorization',
  'cookie',
] as const;

/**
 * Pino's `*` matches exactly one level, so each key is listed at the top and one and two levels down. Request bodies are
 * dropped whole: a body can carry anything (passwords, IDs, bank numbers). Exported so a test can build a logger with the
 * same rules and prove nothing leaks (QA S7).
 */
export const REDACT_PATHS: string[] = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'req.body',
  '*.body',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

export const REDACT_CENSOR = '[redacted]';

/** `/files/<token>` and `/auth/activation/<token>` carry a credential in the path. */
export function redactUrl(url: string): string {
  return url.replace(/(\/(?:files|auth\/activation)\/)[^/?#]+/, '$1[redacted]').replace(/([?&](?:token|code)=)[^&#]*/g, '$1[redacted]');
}

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
  ...(isProd || isTest
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
});
