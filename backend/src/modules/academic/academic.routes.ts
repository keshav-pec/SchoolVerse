import { Router } from 'express';
import { mount } from '../../core/http';
import { gradeOfferingRouter, sectionRouter, subjectOfferingRouter, termRouter } from './offering.routes';
import { boardRouter, gradeRouter, subjectRouter } from './reference.routes';
import { choiceGroupRouter, constraintRouter, contextRouter, gradeRulesRouter, programmeRouter } from './rules.routes';
import { sessionRouter } from './session.routes';

/** Module 2 — Academic Structure & Session Setup. Mounted at the API root; paths follow the PRD. */
export const academicRouter = Router();
mount(academicRouter, '/boards', boardRouter);
mount(academicRouter, '/grades', gradeRouter);
mount(academicRouter, '/subjects', subjectRouter);
mount(academicRouter, '/academic-sessions', sessionRouter);
mount(academicRouter, '/grade-offerings', gradeOfferingRouter);
mount(academicRouter, '/grade-offerings', gradeRulesRouter);
mount(academicRouter, '/sections', sectionRouter);
mount(academicRouter, '/subject-offerings', subjectOfferingRouter);
mount(academicRouter, '/terms', termRouter);
mount(academicRouter, '/choice-groups', choiceGroupRouter);
mount(academicRouter, '/constraints', constraintRouter);
mount(academicRouter, '/academic-programmes', programmeRouter);
mount(academicRouter, '/academic-context', contextRouter);
