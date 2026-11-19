import { Router } from 'express';
import {
  createSectionsSchema,
  createSubjectOfferingsSchema,
  updateClassOfferingSchema,
  updateSectionSchema,
  updateSubjectOfferingSchema,
  updateTermSchema,
  uuidSchema,
} from '@shared';
import { z } from 'zod';
import { created, noContent, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as offerings from './offering.service';
import * as terms from './term.service';

const classOfferingParams = z.object({ classOfferingId: uuidSchema });
const copyParams = z.object({ classOfferingId: uuidSchema, otherClassOfferingId: uuidSchema });
const sectionParams = z.object({ sectionId: uuidSchema });
const subjectOfferingParams = z.object({ subjectOfferingId: uuidSchema });
const termParams = z.object({ termId: uuidSchema });

/** /class-offerings/:id — a class offering with its sections and subjects. */
export const classOfferingRouter = Router();
classOfferingRouter.use(authenticate);

classOfferingRouter.get('/:classOfferingId', requirePermission('academic:view'), validate({ params: classOfferingParams }), async (req, res) => {
  ok(res, await offerings.getClassOfferingDTO(contextOf(req), req.params.classOfferingId as string));
});

classOfferingRouter.patch(
  '/:classOfferingId',
  requirePermission('academic:manage'),
  validate({ params: classOfferingParams, body: updateClassOfferingSchema }),
  async (req, res) => {
    ok(res, await offerings.updateClassOffering(contextOf(req), req.params.classOfferingId as string, req.body));
  },
);

classOfferingRouter.delete('/:classOfferingId', requirePermission('academic:manage'), validate({ params: classOfferingParams }), async (req, res) => {
  await offerings.deleteClassOffering(contextOf(req), req.params.classOfferingId as string);
  noContent(res);
});

// ── sections (AS-04)
classOfferingRouter.get('/:classOfferingId/sections', requirePermission('academic:view'), validate({ params: classOfferingParams }), async (req, res) => {
  ok(res, await offerings.listSections(contextOf(req), req.params.classOfferingId as string));
});

classOfferingRouter.post(
  '/:classOfferingId/sections',
  requirePermission('academic:manage'),
  validate({ params: classOfferingParams, body: createSectionsSchema }),
  async (req, res) => {
    created(res, await offerings.createSections(contextOf(req), req.params.classOfferingId as string, req.body));
  },
);

// ── subject offerings (AS-07)
classOfferingRouter.get('/:classOfferingId/subjects', requirePermission('academic:view'), validate({ params: classOfferingParams }), async (req, res) => {
  ok(res, await offerings.listSubjectOfferings(contextOf(req), req.params.classOfferingId as string));
});

classOfferingRouter.post(
  '/:classOfferingId/subjects',
  requirePermission('academic:manage'),
  validate({ params: classOfferingParams, body: createSubjectOfferingsSchema }),
  async (req, res) => {
    created(res, await offerings.createSubjectOfferings(contextOf(req), req.params.classOfferingId as string, req.body));
  },
);

classOfferingRouter.post(
  '/:classOfferingId/subjects/copy-from/:otherClassOfferingId',
  requirePermission('academic:manage'),
  validate({ params: copyParams }),
  async (req, res) => {
    created(res, await offerings.copySubjectOfferings(contextOf(req), req.params.classOfferingId as string, req.params.otherClassOfferingId as string));
  },
);

/** /sections/:id */
export const sectionRouter = Router();
sectionRouter.use(authenticate);

sectionRouter.patch('/:sectionId', requirePermission('academic:manage'), validate({ params: sectionParams, body: updateSectionSchema }), async (req, res) => {
  ok(res, await offerings.updateSection(contextOf(req), req.params.sectionId as string, req.body));
});

sectionRouter.delete('/:sectionId', requirePermission('academic:manage'), validate({ params: sectionParams }), async (req, res) => {
  await offerings.deleteSection(contextOf(req), req.params.sectionId as string);
  noContent(res);
});

/** /subject-offerings/:id */
export const subjectOfferingRouter = Router();
subjectOfferingRouter.use(authenticate);

subjectOfferingRouter.patch(
  '/:subjectOfferingId',
  requirePermission('academic:manage'),
  validate({ params: subjectOfferingParams, body: updateSubjectOfferingSchema }),
  async (req, res) => {
    ok(res, await offerings.updateSubjectOffering(contextOf(req), req.params.subjectOfferingId as string, req.body));
  },
);

subjectOfferingRouter.delete('/:subjectOfferingId', requirePermission('academic:manage'), validate({ params: subjectOfferingParams }), async (req, res) => {
  await offerings.deleteSubjectOffering(contextOf(req), req.params.subjectOfferingId as string);
  noContent(res);
});

/** /terms/:id */
export const termRouter = Router();
termRouter.use(authenticate);

termRouter.patch('/:termId', requirePermission('academic:manage'), validate({ params: termParams, body: updateTermSchema }), async (req, res) => {
  ok(res, await terms.updateTerm(contextOf(req), req.params.termId as string, req.body));
});

termRouter.delete('/:termId', requirePermission('academic:manage'), validate({ params: termParams }), async (req, res) => {
  await terms.deleteTerm(contextOf(req), req.params.termId as string);
  noContent(res);
});
