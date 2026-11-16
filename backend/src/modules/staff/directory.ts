import type { ClientSession } from 'mongoose';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { Location } from '../locations/location.model';
import { LocationAssignment } from './assignment.models';
import { Employee, type EmployeeDoc } from './employee.model';
import { Department, Designation, type StaffMasterDoc } from './master.model';
import { fullNameOf, placementOf, type Hydration } from './mappers';
import { Person, type PersonDoc } from './person.model';
import { todayFor } from './status';

/**
 * Loads what the mappers need for a set of employees in a handful of batched queries (never one per row).
 * `people` may be passed in when the caller already has them (the directory query joins them).
 */
export async function hydrate(
  ctx: ServiceContext,
  employees: EmployeeDoc[],
  options: { people?: PersonDoc[]; today?: string; db?: ClientSession } = {},
): Promise<Hydration> {
  const db = options.db ?? null;
  const today = options.today ?? (await todayFor(ctx, options.db));
  const tenantId = ctx.tenantId;
  const employeeIds = employees.map((e) => e._id);
  const managerIds = [...new Set(employees.map((e) => e.reportingManagerId).filter((id): id is string => Boolean(id)))];

  const [people, departments, designations, assignments, managers] = await Promise.all([
    options.people ??
      Person.find({ tenantId, _id: { $in: [...new Set(employees.map((e) => e.personId))] } })
        .session(db)
        .lean<PersonDoc[]>(),
    Department.find({ tenantId, _id: { $in: [...new Set(employees.map((e) => e.departmentId))] } })
      .session(db)
      .lean<StaffMasterDoc[]>(),
    Designation.find({ tenantId, _id: { $in: [...new Set(employees.map((e) => e.designationId))] } })
      .session(db)
      .lean<StaffMasterDoc[]>(),
    LocationAssignment.find({ tenantId, employeeId: { $in: employeeIds } })
      .session(db)
      .lean(),
    managerIds.length ? Employee.find({ tenantId, _id: { $in: managerIds } }).session(db).lean<EmployeeDoc[]>() : Promise.resolve([] as EmployeeDoc[]),
  ]);

  const managerPeople = managerIds.length
    ? await Person.find({ tenantId, _id: { $in: [...new Set(managers.map((m) => m.personId))] } })
        .session(db)
        .lean<PersonDoc[]>()
    : [];
  const locations = await Location.find({ tenantId, _id: { $in: [...new Set(assignments.map((a) => a.locationId))] } })
    .session(db)
    .select('locationCode displayName')
    .lean<{ _id: string; locationCode: string; displayName: string }[]>();
  const locationLabel = new Map(locations.map((l) => [l._id, { locationCode: l.locationCode, displayName: l.displayName }]));

  const peopleById = new Map(people.map((p) => [p._id, p]));
  const placements = new Map<string, ReturnType<typeof placementOf>>();
  for (const id of employeeIds) {
    const rows = assignments
      .filter((a) => a.employeeId === id)
      .map((doc) => ({ doc, ref: locationLabel.get(doc.locationId) ?? { locationCode: '?', displayName: 'Unknown location' } }));
    placements.set(id, placementOf(rows, today));
  }
  const managerPeopleById = new Map(managerPeople.map((p) => [p._id, p]));

  return {
    today,
    people: peopleById,
    departments: new Map(departments.map((d) => [d._id, d])),
    designations: new Map(designations.map((d) => [d._id, d])),
    placements,
    managers: new Map(
      managers.map((m) => [m._id, { employeeId: m._id, employeeCode: m.employeeCode, fullName: fullNameOf(managerPeopleById.get(m.personId)!) }]),
    ),
  };
}
