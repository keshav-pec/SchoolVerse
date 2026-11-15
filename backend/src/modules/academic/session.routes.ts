import { Router } from 'express';
import {
  createGradeOfferingsSchema,
  createSessionSchema,
  createTermSchema,
  listSessionsQuerySchema,
  updateSessionSchema,
  uuidSchema,
  type ListSessionsQuery,
} from '@shared';
import { z } from 'zod';
import { created, noContent, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as offerings from './offering.service';
import * as sessions from './session.service';
import * as terms from './term.service';

const sessionParams = z.object({ academicSessionId: uuidSchema });
const locationQuery = z.object({ locationId: uuidSchema.optional() });

/** /academic-sessions — the session itself plus the collections that belong directly to it. */
export const sessionRouter = Router();
sessionRouter.use(authenticate);

sessionRouter.get('/', requirePermission('academic:view'), validate({ query: listSessionsQuerySchema }), async (req, res) => {
  ok(res, await sessions.listSessions(contextOf(req), res.locals.query as ListSessionsQuery));
});

sessionRouter.post('/', requirePermission('academic:manage'), validate({ body: createSessionSchema }), async (req, res) => {
  created(res, await sessions.createSession(contextOf(req), req.body));
});

sessionRouter.get('/:academicSessionId', requirePermission('academic:view'), validate({ params: sessionParams }), async (req, res) => {
  ok(res, await sessions.getSessionDTO(contextOf(req), req.params.academicSessionId as string));
});

sessionRouter.patch(
  '/:academicSessionId',
  requirePermission('academic:manage'),
  validate({ params: sessionParams, body: updateSessionSchema }),
  async (req, res) => {
    ok(res, await sessions.updateSession(contextOf(req), req.params.academicSessionId as string, req.body));
  },
);

/** Hard delete, DRAFT only. */
sessionRouter.delete('/:academicSessionId', requirePermission('academic:manage'), validate({ params: sessionParams }), async (req, res) => {
  await sessions.deleteSession(contextOf(req), req.params.academicSessionId as string);
  noContent(res);
});

// ── grade offerings (AS-03)
sessionRouter.get(
  '/:academicSessionId/grade-offerings',
  requirePermission('academic:view'),
  validate({ params: sessionParams, query: locationQuery }),
  async (req, res) => {
    const { locationId } = res.locals.query as z.output<typeof locationQuery>;
    ok(res, await offerings.listGradeOfferings(contextOf(req), req.params.academicSessionId as string, locationId));
  },
);

sessionRouter.post(
  '/:academicSessionId/grade-offerings',
  requirePermission('academic:manage'),
  validate({ params: sessionParams, body: createGradeOfferingsSchema }),
  async (req, res) => {
    created(res, await offerings.createGradeOfferings(contextOf(req), req.params.academicSessionId as string, req.body));
  },
);

// ── terms (AS-12)
sessionRouter.get(
  '/:academicSessionId/terms',
  requirePermission('academic:view'),
  validate({ params: sessionParams, query: locationQuery }),
  async (req, res) => {
    const { locationId } = res.locals.query as z.output<typeof locationQuery>;
    ok(res, await terms.listTerms(contextOf(req), req.params.academicSessionId as string, locationId));
  },
);

sessionRouter.post(
  '/:academicSessionId/terms',
  requirePermission('academic:manage'),
  validate({ params: sessionParams, body: createTermSchema }),
  async (req, res) => {
    created(res, await terms.createTerm(contextOf(req), req.params.academicSessionId as string, req.body));
  },
);
