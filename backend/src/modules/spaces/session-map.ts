import type { ClientSession } from 'mongoose';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassOffering, SectionOffering, type ClassOfferingDoc, type SectionOfferingDoc } from '../academic/offering.model';
import { sectionLabel } from './sections';

/**
 * The same section in another session, found the way the Module 2 clone made it: same class, same campus, same section code.
 * Used for "same room as last year" in recommendations and for carrying Home Classrooms forward.
 */
export interface SectionPair {
  from: { section: SectionOfferingDoc; klass: ClassOfferingDoc; label: string };
  to: { section: SectionOfferingDoc; klass: ClassOfferingDoc; label: string } | null;
}

export async function pairSections(ctx: ServiceContext, input: { fromSessionId: string; toSessionId: string; locationId: string }, db?: ClientSession): Promise<SectionPair[]> {
  const find = async (sessionId: string) => {
    const classes = await ClassOffering.find({ tenantId: ctx.tenantId, sessionId, locationId: input.locationId }).session(db ?? null).lean<ClassOfferingDoc[]>();
    const sections = await SectionOffering.find({ tenantId: ctx.tenantId, sessionId, locationId: input.locationId }).session(db ?? null).lean<SectionOfferingDoc[]>();
    return { classes: new Map(classes.map((c) => [c._id, c])), sections };
  };
  const from = await find(input.fromSessionId);
  const to = await find(input.toSessionId);
  const toByKey = new Map<string, { section: SectionOfferingDoc; klass: ClassOfferingDoc; label: string }>();
  for (const section of to.sections) {
    const klass = to.classes.get(section.classOfferingId);
    if (klass && section.status === 'ACTIVE') toByKey.set(`${klass.classId}|${section.sectionCode}`, { section, klass, label: sectionLabel(klass, section) });
  }
  const pairs: SectionPair[] = [];
  for (const section of from.sections) {
    const klass = from.classes.get(section.classOfferingId);
    if (!klass) continue;
    pairs.push({ from: { section, klass, label: sectionLabel(klass, section) }, to: toByKey.get(`${klass.classId}|${section.sectionCode}`) ?? null });
  }
  return pairs;
}
