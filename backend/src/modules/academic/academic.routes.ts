import { Router } from 'express';
import { gradeOfferingRouter, sectionRouter, subjectOfferingRouter, termRouter } from './offering.routes';
import { boardRouter, gradeRouter, subjectRouter } from './reference.routes';
import { sessionRouter } from './session.routes';

/** Module 2 — Academic Structure & Session Setup. Mounted at the API root; paths follow the PRD. */
export const academicRouter = Router();
academicRouter.use('/boards', boardRouter);
academicRouter.use('/grades', gradeRouter);
academicRouter.use('/subjects', subjectRouter);
academicRouter.use('/academic-sessions', sessionRouter);
academicRouter.use('/grade-offerings', gradeOfferingRouter);
academicRouter.use('/sections', sectionRouter);
academicRouter.use('/subject-offerings', subjectOfferingRouter);
academicRouter.use('/terms', termRouter);
