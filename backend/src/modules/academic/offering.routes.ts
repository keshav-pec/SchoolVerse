import { Router } from 'express';
import {
  createSectionsSchema,
  createSubjectOfferingsSchema,
  updateGradeOfferingSchema,
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

const gradeOfferingParams = z.object({ gradeOfferingId: uuidSchema });
const copyParams = z.object({ gradeOfferingId: uuidSchema, otherGradeOfferingId: uuidSchema });
const sectionParams = z.object({ sectionId: uuidSchema });
const subjectOfferingParams = z.object({ subjectOfferingId: uuidSchema });
const termParams = z.object({ termId: uuidSchema });

/** /grade-offerings/:id — a grade offering with its sections and subjects. */
export const gradeOfferingRouter = Router();
gradeOfferingRouter.use(authenticate);

gradeOfferingRouter.get('/:gradeOfferingId', requirePermission('academic:view'), validate({ params: gradeOfferingParams }), async (req, res) => {
  ok(res, await offerings.getGradeOfferingDTO(contextOf(req), req.params.gradeOfferingId as string));
});

gradeOfferingRouter.patch(
  '/:gradeOfferingId',
  requirePermission('academic:manage'),
  validate({ params: gradeOfferingParams, body: updateGradeOfferingSchema }),
  async (req, res) => {
    ok(res, await offerings.updateGradeOffering(contextOf(req), req.params.gradeOfferingId as string, req.body));
  },
);

gradeOfferingRouter.delete('/:gradeOfferingId', requirePermission('academic:manage'), validate({ params: gradeOfferingParams }), async (req, res) => {
  await offerings.deleteGradeOffering(contextOf(req), req.params.gradeOfferingId as string);
  noContent(res);
});

// ── sections (AS-04)
gradeOfferingRouter.get('/:gradeOfferingId/sections', requirePermission('academic:view'), validate({ params: gradeOfferingParams }), async (req, res) => {
  ok(res, await offerings.listSections(contextOf(req), req.params.gradeOfferingId as string));
});

gradeOfferingRouter.post(
  '/:gradeOfferingId/sections',
  requirePermission('academic:manage'),
  validate({ params: gradeOfferingParams, body: createSectionsSchema }),
  async (req, res) => {
    created(res, await offerings.createSections(contextOf(req), req.params.gradeOfferingId as string, req.body));
  },
);

// ── subject offerings (AS-07)
gradeOfferingRouter.get('/:gradeOfferingId/subjects', requirePermission('academic:view'), validate({ params: gradeOfferingParams }), async (req, res) => {
  ok(res, await offerings.listSubjectOfferings(contextOf(req), req.params.gradeOfferingId as string));
});

gradeOfferingRouter.post(
  '/:gradeOfferingId/subjects',
  requirePermission('academic:manage'),
  validate({ params: gradeOfferingParams, body: createSubjectOfferingsSchema }),
  async (req, res) => {
    created(res, await offerings.createSubjectOfferings(contextOf(req), req.params.gradeOfferingId as string, req.body));
  },
);

gradeOfferingRouter.post(
  '/:gradeOfferingId/subjects/copy-from/:otherGradeOfferingId',
  requirePermission('academic:manage'),
  validate({ params: copyParams }),
  async (req, res) => {
    created(res, await offerings.copySubjectOfferings(contextOf(req), req.params.gradeOfferingId as string, req.params.otherGradeOfferingId as string));
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
