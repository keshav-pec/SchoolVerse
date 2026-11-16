import { Router } from 'express';
import {
  changeEmployeeStatusSchema,
  createAcademicAssignmentsSchema,
  createEmployeeSchema,
  createLocationAssignmentSchema,
  createMasterSchema,
  createResponsibilitySchema,
  employeeHistoryQuerySchema,
  endAssignmentSchema,
  exitEmployeeSchema,
  listEmployeesQuerySchema,
  listMastersQuerySchema,
  transferSchema,
  updateEmployeeSchema,
  updateMasterSchema,
  uuidSchema,
} from '@shared';
import { z } from 'zod';
import { created, noContent, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as academic from './academic-assignment.service';
import * as employees from './employee.service';
import { getEmployeeHistory } from './history.service';
import * as lifecycle from './lifecycle.service';
import * as locations from './location-assignment.service';
import { departmentService, designationService } from './master.service';
import * as responsibilities from './responsibility.service';

/**
 * Module 3 — Faculty & Staff. Mounted at the API root; paths follow the Epic. Permission checks come first, so a caller
 * without access learns nothing (not even whether an id exists).
 */
export const staffRouter = Router();
// Mounted at the API root, so authentication is applied per path (it must not catch unrelated routes such as /dev).
staffRouter.use(['/departments', '/designations', '/employees', '/location-assignments', '/academic-assignments', '/responsibilities'], authenticate);

const idParams = z.object({ id: uuidSchema });

// ───────────────────────────────────────────────────────────── departments & designations (FSM-02)

function mastersRouter(service: typeof departmentService) {
  const router = Router();
  // Anyone who can use the directory can read the lists (filters need them); only managers change them.
  router.get('/', requirePermission('employee:directory'), validate({ query: listMastersQuerySchema }), async (req, res) => {
    ok(res, await service.list(contextOf(req), res.locals.query));
  });
  router.post('/', requirePermission('employee:manage'), validate({ body: createMasterSchema }), async (req, res) => {
    created(res, await service.create(contextOf(req), req.body));
  });
  router.post('/suggested', requirePermission('employee:manage'), async (req, res) => {
    created(res, await service.addSuggested(contextOf(req)));
  });
  router.patch('/:id', requirePermission('employee:manage'), validate({ params: idParams, body: updateMasterSchema }), async (req, res) => {
    ok(res, await service.update(contextOf(req), req.params.id as string, req.body));
  });
  return router;
}
staffRouter.use('/departments', mastersRouter(departmentService));
staffRouter.use('/designations', mastersRouter(designationService as unknown as typeof departmentService));

// ───────────────────────────────────────────────────────────── employees (FSM-01)

staffRouter.get('/employees', requirePermission('employee:directory'), validate({ query: listEmployeesQuerySchema }), async (req, res) => {
  ok(res, await employees.listEmployees(contextOf(req), res.locals.query));
});

staffRouter.post('/employees', requirePermission('employee:manage'), validate({ body: createEmployeeSchema }), async (req, res) => {
  created(res, await employees.createEmployee(contextOf(req), req.body));
});

staffRouter.get('/employees/:id', requirePermission('employee:directory'), validate({ params: idParams }), async (req, res) => {
  ok(res, await employees.getEmployee(contextOf(req), req.params.id as string));
});

staffRouter.patch('/employees/:id', requirePermission('employee:manage'), validate({ params: idParams, body: updateEmployeeSchema }), async (req, res) => {
  ok(res, await employees.updateEmployee(contextOf(req), req.params.id as string, req.body));
});

staffRouter.delete('/employees/:id', requirePermission('employee:manage'), validate({ params: idParams }), async (req, res) => {
  await employees.deleteEmployee(contextOf(req), req.params.id as string);
  noContent(res);
});

staffRouter.get('/employees/:id/history', requirePermission('employee:view'), validate({ params: idParams, query: employeeHistoryQuerySchema }), async (req, res) => {
  ok(res, await getEmployeeHistory(contextOf(req), req.params.id as string, res.locals.query.limit));
});

// ───────────────────────────────────────────────────────────── lifecycle

staffRouter.post('/employees/:id/status', requirePermission('employee:manage'), validate({ params: idParams, body: changeEmployeeStatusSchema }), async (req, res) => {
  ok(res, await lifecycle.changeEmployeeStatus(contextOf(req), req.params.id as string, req.body));
});

staffRouter.post('/employees/:id/exit', requirePermission('employee:manage'), validate({ params: idParams, body: exitEmployeeSchema }), async (req, res) => {
  ok(res, await lifecycle.exitEmployee(contextOf(req), req.params.id as string, req.body));
});

staffRouter.post('/employees/:id/cancel-exit', requirePermission('employee:manage'), validate({ params: idParams }), async (req, res) => {
  ok(res, await lifecycle.cancelExit(contextOf(req), req.params.id as string));
});

// ───────────────────────────────────────────────────────────── location assignments (FSM-03)

staffRouter.get('/employees/:id/location-assignments', requirePermission('employee:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await locations.listLocationAssignments(contextOf(req), req.params.id as string));
});

staffRouter.post('/employees/:id/location-assignments', requirePermission('employee:manage'), validate({ params: idParams, body: createLocationAssignmentSchema }), async (req, res) => {
  created(res, await locations.addLocationAssignment(contextOf(req), req.params.id as string, req.body));
});

staffRouter.post('/employees/:id/transfer', requirePermission('employee:manage'), validate({ params: idParams, body: transferSchema }), async (req, res) => {
  ok(res, await locations.transferEmployee(contextOf(req), req.params.id as string, req.body));
});

staffRouter.post('/location-assignments/:id/end', requirePermission('employee:manage'), validate({ params: idParams, body: endAssignmentSchema }), async (req, res) => {
  ok(res, await locations.endLocationAssignment(contextOf(req), req.params.id as string, req.body));
});

staffRouter.post('/location-assignments/:id/cancel', requirePermission('employee:manage'), validate({ params: idParams }), async (req, res) => {
  ok(res, await locations.cancelLocationAssignment(contextOf(req), req.params.id as string));
});

// ───────────────────────────────────────────────────────────── faculty academic assignments (FSM-04)

staffRouter.get(
  '/employees/:id/academic-assignments',
  requirePermission('employee:view'),
  validate({ params: idParams, query: z.object({ academicSessionId: uuidSchema.optional() }) }),
  async (req, res) => {
    ok(res, await academic.listAcademicAssignments(contextOf(req), req.params.id as string, res.locals.query));
  },
);

staffRouter.post('/employees/:id/academic-assignments', requirePermission('employee:manage'), validate({ params: idParams, body: createAcademicAssignmentsSchema }), async (req, res) => {
  created(res, await academic.createAcademicAssignments(contextOf(req), req.params.id as string, req.body));
});

staffRouter.post('/academic-assignments/:id/end', requirePermission('employee:manage'), validate({ params: idParams, body: endAssignmentSchema }), async (req, res) => {
  ok(res, await academic.endAcademicAssignment(contextOf(req), req.params.id as string, req.body));
});

staffRouter.post('/academic-assignments/:id/cancel', requirePermission('employee:manage'), validate({ params: idParams }), async (req, res) => {
  ok(res, await academic.cancelAcademicAssignment(contextOf(req), req.params.id as string));
});

// ───────────────────────────────────────────────────────────── staff responsibilities (FSM-05)

staffRouter.get('/employees/:id/responsibilities', requirePermission('employee:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await responsibilities.listResponsibilities(contextOf(req), req.params.id as string));
});

staffRouter.post('/employees/:id/responsibilities', requirePermission('employee:manage'), validate({ params: idParams, body: createResponsibilitySchema }), async (req, res) => {
  created(res, await responsibilities.createResponsibility(contextOf(req), req.params.id as string, req.body));
});

staffRouter.post('/responsibilities/:id/end', requirePermission('employee:manage'), validate({ params: idParams, body: endAssignmentSchema }), async (req, res) => {
  ok(res, await responsibilities.endResponsibility(contextOf(req), req.params.id as string, req.body));
});

staffRouter.post('/responsibilities/:id/cancel', requirePermission('employee:manage'), validate({ params: idParams }), async (req, res) => {
  ok(res, await responsibilities.cancelResponsibility(contextOf(req), req.params.id as string));
});
