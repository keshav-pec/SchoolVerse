import type { SessionStatus } from '@shared';
import { registerLocationDependency } from '../dependencies/registry';
import { GradeOffering } from './offering.model';
import { AcademicSession } from './session.model';

let registered = false;

/**
 * Module 2 on the location dependency registry (AS-02 / Part 1 item 19): a location with grade offerings
 * in a non-closed session cannot be archived, and a location any session has used keeps its code.
 */
export function registerAcademicLocationDependency() {
  if (registered) return;
  registered = true;
  const OPEN: SessionStatus[] = ['DRAFT', 'PUBLISHED', 'ACTIVE'];

  registerLocationDependency({
    key: 'academic.structure',
    label: 'Academic structure',
    message: (n) => `${n} grade${n === 1 ? ' is' : 's are'} set up at this location in a session that is not closed yet.`,
    async countActive({ tenantId, locationId, session }) {
      const open = await AcademicSession.find({ tenantId, status: { $in: OPEN } }).select('_id').session(session ?? null).lean<{ _id: string }[]>();
      if (open.length === 0) return 0;
      return GradeOffering.countDocuments({ tenantId, locationId, sessionId: { $in: open.map((s) => s._id) } }).session(session ?? null);
    },
    async countAny({ tenantId, locationId, session }) {
      const [offerings, sessions] = await Promise.all([
        GradeOffering.countDocuments({ tenantId, locationId }).session(session ?? null),
        AcademicSession.countDocuments({ tenantId, 'locations.locationId': locationId }).session(session ?? null),
      ]);
      return offerings + sessions;
    },
  });
}
