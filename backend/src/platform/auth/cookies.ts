import type { CookieOptions, Response } from 'express';
import { env } from '../../config/env';

export const ACCESS_COOKIE = 'sv_access';
export const REFRESH_COOKIE = 'sv_refresh';
/** Refresh cookie is only sent to auth endpoints, never to business APIs. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

function baseOptions(): CookieOptions {
  return { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax' };
}

export function setAuthCookies(res: Response, tokens: { accessToken: string; refreshToken: string }) {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...baseOptions(),
    path: '/',
    maxAge: env.ACCESS_TOKEN_TTL_MINUTES * 60 * 1000,
  });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...baseOptions(),
    path: REFRESH_COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...baseOptions(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseOptions(), path: REFRESH_COOKIE_PATH });
}
