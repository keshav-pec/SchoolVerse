import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../../core/http';
import { validate } from '../../core/validate';
import { SKIP_TENANT_SCOPE } from '../../db/plugins/tenant-scope';
import { DevOutbox } from './notifier';

/**
 * DEV / DEMO ONLY — mounted only when `DEV_OUTBOX` is on (never by default in production). It shows the emails the app
 * would have sent, so an activation or reset link can be opened without an email provider. It is not authenticated, because
 * the person who needs a link (activating, forgot password) is not signed in. It holds synthetic demo data only.
 */
export const outboxRouter = Router();

outboxRouter.get('/', validate({ query: z.object({ to: z.string().trim().toLowerCase().max(254).optional() }) }), async (_req, res) => {
  const { to } = res.locals.query as { to?: string };
  const rows = await DevOutbox.find(to ? { to } : {}).setOptions(SKIP_TENANT_SCOPE).sort({ createdAt: -1 }).limit(20).lean();
  ok(res, { items: rows.map((r) => ({ to: r.to, template: r.template, link: r.link, createdAt: r.createdAt.toISOString() })) });
});
