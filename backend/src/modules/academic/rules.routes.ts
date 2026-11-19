import { Router } from 'express';
import {
  academicContextQuerySchema,
  createChoiceGroupSchema,
  createConstraintSchema,
  createProgrammeSchema,
  listProgrammesQuerySchema,
  updateChoiceGroupSchema,
  updateProgrammeSchema,
  uuidSchema,
  type AcademicContextQuery,
  type ListProgrammesQuery,
} from '@shared';
import { z } from 'zod';
import { created, noContent, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import { getAcademicContext } from './context.service';
import * as programmes from './programme.service';
import * as rules from './rules.service';

const classOfferingParams = z.object({ classOfferingId: uuidSchema });
const choiceGroupParams = z.object({ choiceGroupId: uuidSchema });
const constraintParams = z.object({ constraintId: uuidSchema });
const programmeParams = z.object({ programmeId: uuidSchema });

/** /class-offerings/:id/choice-groups and /constraints (mounted beside the Part 1 class-offering routes). */
export const classRulesRouter = Router();
classRulesRouter.use(authenticate);

classRulesRouter.get('/:classOfferingId/choice-groups', requirePermission('academic:view'), validate({ params: classOfferingParams }), async (req, res) => {
  ok(res, await rules.listChoiceGroups(contextOf(req), req.params.classOfferingId as string));
});

classRulesRouter.post(
  '/:classOfferingId/choice-groups',
  requirePermission('academic:manage'),
  validate({ params: classOfferingParams, body: createChoiceGroupSchema }),
  async (req, res) => {
    created(res, await rules.createChoiceGroup(contextOf(req), req.params.classOfferingId as string, req.body));
  },
);

classRulesRouter.get('/:classOfferingId/constraints', requirePermission('academic:view'), validate({ params: classOfferingParams }), async (req, res) => {
  ok(res, await rules.listConstraints(contextOf(req), req.params.classOfferingId as string));
});

classRulesRouter.post(
  '/:classOfferingId/constraints',
  requirePermission('academic:manage'),
  validate({ params: classOfferingParams, body: createConstraintSchema }),
  async (req, res) => {
    created(res, await rules.createConstraint(contextOf(req), req.params.classOfferingId as string, req.body));
  },
);

/** /choice-groups/:id */
export const choiceGroupRouter = Router();
choiceGroupRouter.use(authenticate);

choiceGroupRouter.patch(
  '/:choiceGroupId',
  requirePermission('academic:manage'),
  validate({ params: choiceGroupParams, body: updateChoiceGroupSchema }),
  async (req, res) => {
    ok(res, await rules.updateChoiceGroup(contextOf(req), req.params.choiceGroupId as string, req.body));
  },
);

choiceGroupRouter.delete('/:choiceGroupId', requirePermission('academic:manage'), validate({ params: choiceGroupParams }), async (req, res) => {
  await rules.deleteChoiceGroup(contextOf(req), req.params.choiceGroupId as string);
  noContent(res);
});

/** /constraints/:id */
export const constraintRouter = Router();
constraintRouter.use(authenticate);

constraintRouter.delete('/:constraintId', requirePermission('academic:manage'), validate({ params: constraintParams }), async (req, res) => {
  await rules.deleteConstraint(contextOf(req), req.params.constraintId as string);
  noContent(res);
});

/** /academic-programmes */
export const programmeRouter = Router();
programmeRouter.use(authenticate);

programmeRouter.get('/', requirePermission('academic:view'), validate({ query: listProgrammesQuerySchema }), async (req, res) => {
  const { academicSessionId, locationId } = res.locals.query as ListProgrammesQuery;
  ok(res, await programmes.listProgrammes(contextOf(req), academicSessionId, locationId));
});

programmeRouter.post('/', requirePermission('academic:manage'), validate({ body: createProgrammeSchema }), async (req, res) => {
  created(res, await programmes.createProgramme(contextOf(req), req.body));
});

programmeRouter.get('/:programmeId', requirePermission('academic:view'), validate({ params: programmeParams }), async (req, res) => {
  ok(res, await programmes.getProgrammeDTO(contextOf(req), req.params.programmeId as string));
});

programmeRouter.patch(
  '/:programmeId',
  requirePermission('academic:manage'),
  validate({ params: programmeParams, body: updateProgrammeSchema }),
  async (req, res) => {
    ok(res, await programmes.updateProgramme(contextOf(req), req.params.programmeId as string, req.body));
  },
);

programmeRouter.delete('/:programmeId', requirePermission('academic:manage'), validate({ params: programmeParams }), async (req, res) => {
  await programmes.deleteProgramme(contextOf(req), req.params.programmeId as string);
  noContent(res);
});

/** GET /academic-context — the downstream contract over HTTP. */
export const contextRouter = Router();
contextRouter.use(authenticate);
contextRouter.get('/', requirePermission('academic:view'), validate({ query: academicContextQuerySchema }), async (req, res) => {
  ok(res, await getAcademicContext(contextOf(req), res.locals.query as AcademicContextQuery));
});
