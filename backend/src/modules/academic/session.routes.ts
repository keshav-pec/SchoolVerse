import { Router } from 'express';
import {
  applySectionsToAllSchema,
  createClassOfferingsSchema,
  createSessionSchema,
  cloneSessionSchema,
  createTermSchema,
  listSessionsQuerySchema,
  updateSessionSchema,
  uuidSchema,
  type ListSessionsQuery,
} from '@shared';
import { SESSION_ACTIONS, type SessionAction } from '@shared';
import { z } from 'zod';
import { created, noContent, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import { cloneSession } from './clone.service';
import { getCurrentSession, getOverview } from './context.service';
import { changeSessionStatus } from './lifecycle.service';
import * as offerings from './offering.service';
import * as sessions from './session.service';
import * as terms from './term.service';
import { validateSession } from './validation.service';

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

/** The ACTIVE session. Declared before `/:academicSessionId` so "current" is not read as an id. */
sessionRouter.get('/current', requirePermission('academic:view'), async (req, res) => {
  ok(res, await getCurrentSession(contextOf(req)));
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

// ── class offerings (AS-03)
sessionRouter.get(
  '/:academicSessionId/class-offerings',
  requirePermission('academic:view'),
  validate({ params: sessionParams, query: locationQuery }),
  async (req, res) => {
    const { locationId } = res.locals.query as z.output<typeof locationQuery>;
    ok(res, await offerings.listClassOfferings(contextOf(req), req.params.academicSessionId as string, locationId));
  },
);

sessionRouter.post(
  '/:academicSessionId/class-offerings',
  requirePermission('academic:manage'),
  validate({ params: sessionParams, body: createClassOfferingsSchema }),
  async (req, res) => {
    created(res, await offerings.createClassOfferings(contextOf(req), req.params.academicSessionId as string, req.body));
  },
);

sessionRouter.post(
  '/:academicSessionId/class-offerings/sections',
  requirePermission('academic:manage'),
  validate({ params: sessionParams, body: applySectionsToAllSchema }),
  async (req, res) => {
    created(res, await offerings.applySectionsToAllClasses(contextOf(req), req.params.academicSessionId as string, req.body));
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

// ── dashboard, validation, lifecycle and clone (Part 2)
sessionRouter.get('/:academicSessionId/overview', requirePermission('academic:view_config'), validate({ params: sessionParams }), async (req, res) => {
  ok(res, await getOverview(contextOf(req), req.params.academicSessionId as string));
});

sessionRouter.post('/:academicSessionId/validate', requirePermission('academic:publish'), validate({ params: sessionParams }), async (req, res) => {
  ok(res, await validateSession(contextOf(req), req.params.academicSessionId as string));
});

for (const action of SESSION_ACTIONS as readonly SessionAction[]) {
  sessionRouter.post(`/:academicSessionId/${action}`, requirePermission('academic:publish'), validate({ params: sessionParams }), async (req, res) => {
    ok(res, await changeSessionStatus(contextOf(req), req.params.academicSessionId as string, action));
  });
}

sessionRouter.post(
  '/:academicSessionId/clone',
  requirePermission('academic:publish'),
  validate({ params: sessionParams, body: cloneSessionSchema }),
  async (req, res) => {
    created(res, await cloneSession(contextOf(req), req.params.academicSessionId as string, req.body));
  },
);
