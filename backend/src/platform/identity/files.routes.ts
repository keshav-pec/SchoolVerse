import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import { validate } from '../../core/validate';
import { verifyFileToken } from './crypto';
import { limiter } from './rate-limit';
import { privateStorage } from './private-storage';

/**
 * `GET /files/:signedToken` (PRD §18). The signed, short-lived token is the credential: it was issued only after an
 * authorization check and names one private object. The response is an attachment, never cached, and never sniffed.
 */
export const filesRouter = Router();

filesRouter.get('/:token', limiter(60), validate({ params: z.object({ token: z.string().min(10).max(2000) }) }), async (req, res) => {
  const payload = verifyFileToken(req.params.token as string);
  // Tampered, malformed and expired links all look the same.
  if (!payload) throw new AppError('TOKEN_INVALID');
  const body = await privateStorage.read(payload.k);
  if (!body) throw AppError.notFound('File not found.');

  res.setHeader('Content-Type', payload.m);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Content-Disposition', `attachment; filename="${payload.n.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.end(body);
});
