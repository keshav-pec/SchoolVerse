import { Router } from 'express';
import { mount } from '../../core/http';
import { classOfferingRouter, sectionRouter, subjectOfferingRouter, termRouter } from './offering.routes';
import { boardRouter, classRouter, subjectRouter } from './reference.routes';
import { choiceGroupRouter, constraintRouter, contextRouter, classRulesRouter, programmeRouter } from './rules.routes';
import { sessionRouter } from './session.routes';

/** Module 2 — Academic Structure & Session Setup. Mounted at the API root; paths follow the PRD. */
export const academicRouter = Router();
mount(academicRouter, '/boards', boardRouter);
mount(academicRouter, '/classes', classRouter);
mount(academicRouter, '/subjects', subjectRouter);
mount(academicRouter, '/academic-sessions', sessionRouter);
mount(academicRouter, '/class-offerings', classOfferingRouter);
mount(academicRouter, '/class-offerings', classRulesRouter);
mount(academicRouter, '/sections', sectionRouter);
mount(academicRouter, '/subject-offerings', subjectOfferingRouter);
mount(academicRouter, '/terms', termRouter);
mount(academicRouter, '/choice-groups', choiceGroupRouter);
mount(academicRouter, '/constraints', constraintRouter);
mount(academicRouter, '/academic-programmes', programmeRouter);
mount(academicRouter, '/academic-context', contextRouter);
