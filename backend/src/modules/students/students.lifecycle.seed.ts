import {
  requestTransferCertificateSchema,
  startWithdrawalSchema,
  type CreateStudentResultDTO,
} from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { changeSessionStatus } from '../academic/lifecycle.service';
import { validateSession } from '../academic/validation.service';
import { Person } from '../staff/person.model';
import { approveCertificate, requestCertificate, updateCertificate } from './tc.service';
import { enablePortal, revokePortal } from './portal.service';
import { startWithdrawal } from './exit.service';
import { StudentGuardianLink } from './student.models';

/**
 * The Part 3 demo data (synthetic only, `.demo` emails). Built on the students from `students.seed.ts`, through the real services:
 *  - **a parent with two children**: Simran Kaur (parent@greenfield.demo, already activated) has portal access to Riya and Arjun;
 *  - **a pending invitation**: Farah Khan, mother of Zoya, was invited and has not activated yet (the link is in the dev outbox);
 *  - **a revoked child link**: Meena Malhotra was invited for Aarav and her access was removed (she keeps her login);
 *  - **a student mid-withdrawal**: one Chandigarh student is leaving at the end of the year, and needs a Transfer Certificate;
 *  - **a Transfer Certificate waiting for dues**: another Chandigarh student's TC is in "Pending clearance";
 *  - **2027-28 published**, so promotion can be tried (classes, sections and subjects were cloned from 2026-27).
 *
 * `clean` (what `npm run seed` uses) keeps only Simran's access and the published 2027-28: no invitation waiting, no removed access,
 * nobody leaving.
 */
export async function seedStudentLifecycleDemo(ctx: ServiceContext, input: { students: CreateStudentResultDTO[]; nextSessionId: string }, opts: { clean?: boolean } = {}) {
  const tenantId = ctx.tenantId;

  // A guardian link of a parent, found by the parent's email.
  const linksOf = async (email: string) => {
    const person = await Person.findOne({ tenantId, primaryEmail: email }).lean<{ _id: string }>();
    if (!person) throw new Error(`Seed the students before their parent access (${email}).`);
    return StudentGuardianLink.find({ tenantId, guardianPersonId: person._id, cancelledAt: null }).sort({ createdAt: 1 }).lean<{ _id: string }[]>();
  };

  // Simran already has a login (the demo Parent account): enabling access links it to her person and reuses it.
  for (const link of await linksOf('parent@greenfield.demo')) await enablePortal(ctx, link._id);
  if (opts.clean) return publishNextYear(ctx, input.nextSessionId);
  // Farah is invited and has not opened the link yet.
  for (const link of await linksOf('farah.khan@greenfield.demo')) await enablePortal(ctx, link._id);
  // Meena was invited, then her access to Aarav was removed.
  for (const link of await linksOf('meena.malhotra@greenfield.demo')) {
    await enablePortal(ctx, link._id);
    await revokePortal(ctx, link._id);
  }

  // The first Chandigarh students (the roster puts them after the 30 Mohali ones).
  const leaving = input.students[31];
  const clearance = input.students[32];
  if (leaving) {
    await startWithdrawal(ctx, leaving.student.studentId, startWithdrawalSchema.parse({ leavingDate: '2027-03-31', reasonCategory: 'RELOCATION', destinationSchool: 'Delhi Public School, Gurugram', note: 'Family is moving to Gurugram.', needsTC: true }));
  }
  if (clearance) {
    const tc = await requestCertificate(ctx, clearance.student.studentId, requestTransferCertificateSchema.parse({ reasonForLeaving: 'Moving to another city' }));
    await updateCertificate(ctx, tc.certificateId, { duesStatus: 'PENDING' });
    await approveCertificate(ctx, tc.certificateId); // dues are pending, so it waits in "Pending clearance"
  }

  await publishNextYear(ctx, input.nextSessionId);
}

/** 2027-28 was cloned from 2026-27 (classes, sections, subjects and terms): check it and publish it. */
async function publishNextYear(ctx: ServiceContext, nextSessionId: string) {
  const result = await validateSession(ctx, nextSessionId);
  if (!result.canPublish) throw new Error(`Seed session 2027-28 failed validation: ${result.issues.filter((i) => i.level === 'ERROR').map((i) => i.message).join(' | ')}`);
  await changeSessionStatus(ctx, nextSessionId, 'publish');
}
