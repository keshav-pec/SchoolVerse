import { Router } from 'express';
import {
  createBoardSchema,
  createRuleVersionSchema,
  createSubjectSchema,
  listSubjectsQuerySchema,
  setBoardSubjectCodeSchema,
  updateSubjectSchema,
  uuidSchema,
  type ListSubjectsQuery,
} from '@shared';
import { z } from 'zod';
import { created, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as reference from './reference.service';
import * as subjects from './subject.service';

const boardParams = z.object({ boardId: uuidSchema });
const ruleVersionParams = z.object({ boardId: uuidSchema, ruleVersionId: uuidSchema });
const subjectParams = z.object({ subjectId: uuidSchema });
const boardCodeParams = z.object({ subjectId: uuidSchema, ruleVersionId: uuidSchema });

/** /boards and /classes — reference data (AS-01, AS-03). */
export const boardRouter = Router();
boardRouter.use(authenticate);

boardRouter.get('/', requirePermission('academic:view'), async (req, res) => {
  ok(res, await reference.listBoards(contextOf(req)));
});

boardRouter.post('/', requirePermission('academic:manage'), validate({ body: createBoardSchema }), async (req, res) => {
  created(res, await reference.createBoard(contextOf(req), req.body));
});

boardRouter.get('/:boardId/rule-versions', requirePermission('academic:view'), validate({ params: boardParams }), async (req, res) => {
  ok(res, await reference.listRuleVersions(contextOf(req), req.params.boardId as string));
});

boardRouter.post(
  '/:boardId/rule-versions',
  requirePermission('academic:manage'),
  validate({ params: boardParams, body: createRuleVersionSchema }),
  async (req, res) => {
    created(res, await reference.createRuleVersion(contextOf(req), req.params.boardId as string, req.body));
  },
);

boardRouter.post(
  '/:boardId/rule-versions/:ruleVersionId/publish',
  requirePermission('academic:manage'),
  validate({ params: ruleVersionParams }),
  async (req, res) => {
    ok(res, await reference.publishRuleVersion(contextOf(req), req.params.boardId as string, req.params.ruleVersionId as string));
  },
);

export const classRouter = Router();
classRouter.use(authenticate);
classRouter.get('/', requirePermission('academic:view'), async (_req, res) => {
  ok(res, await reference.listClasses());
});

/** /subjects — subject master and board subject codes (AS-05, AS-06). */
export const subjectRouter = Router();
subjectRouter.use(authenticate);

subjectRouter.get('/', requirePermission('academic:view'), validate({ query: listSubjectsQuerySchema }), async (req, res) => {
  ok(res, await subjects.listSubjects(contextOf(req), res.locals.query as ListSubjectsQuery));
});

subjectRouter.post('/', requirePermission('academic:manage'), validate({ body: createSubjectSchema }), async (req, res) => {
  created(res, await subjects.createSubject(contextOf(req), req.body));
});

subjectRouter.get('/:subjectId', requirePermission('academic:view'), validate({ params: subjectParams }), async (req, res) => {
  ok(res, await subjects.getSubjectDTO(contextOf(req), req.params.subjectId as string));
});

subjectRouter.patch('/:subjectId', requirePermission('academic:manage'), validate({ params: subjectParams, body: updateSubjectSchema }), async (req, res) => {
  ok(res, await subjects.updateSubject(contextOf(req), req.params.subjectId as string, req.body));
});

subjectRouter.put(
  '/:subjectId/board-codes',
  requirePermission('academic:manage'),
  validate({ params: subjectParams, body: setBoardSubjectCodeSchema }),
  async (req, res) => {
    ok(res, await subjects.setBoardSubjectCode(contextOf(req), req.params.subjectId as string, req.body));
  },
);

subjectRouter.delete(
  '/:subjectId/board-codes/:ruleVersionId',
  requirePermission('academic:manage'),
  validate({ params: boardCodeParams }),
  async (req, res) => {
    ok(res, await subjects.removeBoardSubjectCode(contextOf(req), req.params.subjectId as string, req.params.ruleVersionId as string));
  },
);
