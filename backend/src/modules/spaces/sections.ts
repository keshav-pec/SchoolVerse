import type { ClientSession } from 'mongoose';
import type { SectionRefDTO } from '@shared';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassOffering, SectionOffering, type ClassOfferingDoc, type SectionOfferingDoc } from '../academic/offering.model';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { visibleSessionStatuses } from '../academic/session.service';
import { studentService } from '../students/context.service';

/**
 * Where Module 5 reads sections, classes and sessions (Module 2) and section strength (Module 4). Nothing here is copied or stored:
 * a section's name and its student count are looked up each time.
 */

export interface SectionFacts {
  section: SectionOfferingDoc;
  klass: ClassOfferingDoc;
  session: AcademicSessionDoc;
  /** "VIII-A". */
  label: string;
  /** The day strength is counted for: today, held inside the session (a future session counts from its first day, a closed one at its last). */
  asOf: string;
}

export const sectionLabel = (klass: Pick<ClassOfferingDoc, 'displayCode'>, section: Pick<SectionOfferingDoc, 'sectionCode'>) => `${klass.displayCode}-${section.sectionCode}`;

export const clampDate = (date: string, low: string, high: string) => (date < low ? low : date > high ? high : date);

/** Sections with their class and session, keyed by section id. A missing or other-tenant id is simply absent from the map. */
export async function loadSectionFacts(ctx: ServiceContext, sectionIds: string[], today: string, db?: ClientSession): Promise<Map<string, SectionFacts>> {
  const ids = [...new Set(sectionIds)];
  const out = new Map<string, SectionFacts>();
  if (ids.length === 0) return out;
  const sections = await SectionOffering.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).session(db ?? null).lean<SectionOfferingDoc[]>();
  const classes = await ClassOffering.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(sections.map((s) => s.classOfferingId))] } }).session(db ?? null).lean<ClassOfferingDoc[]>();
  const allowed = visibleSessionStatuses(ctx);
  const sessions = await AcademicSession.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(sections.map((s) => s.sessionId))] }, ...(allowed ? { status: { $in: allowed } } : {}) }).session(db ?? null).lean<AcademicSessionDoc[]>();
  const classOf = new Map(classes.map((c) => [c._id, c]));
  const sessionOf = new Map(sessions.map((s) => [s._id, s]));
  for (const section of sections) {
    const klass = classOf.get(section.classOfferingId);
    const session = sessionOf.get(section.sessionId);
    if (!klass || !session) continue;
    out.set(section._id, { section, klass, session, label: sectionLabel(klass, section), asOf: clampDate(today, session.startDate, session.endDate) });
  }
  return out;
}

export async function requireSectionFacts(ctx: ServiceContext, sectionId: string, today: string, db?: ClientSession): Promise<SectionFacts> {
  const facts = (await loadSectionFacts(ctx, [sectionId], today, db)).get(sectionId);
  if (!facts) throw AppError.notFound('Section not found.');
  return facts;
}

/** Live strength for each section, counted by the student module for that section's own day. */
export async function strengthOf(ctx: ServiceContext, facts: Iterable<SectionFacts>, db?: ClientSession): Promise<Map<string, number>> {
  const byDay = new Map<string, string[]>();
  for (const f of facts) byDay.set(f.asOf, [...(byDay.get(f.asOf) ?? []), f.section._id]);
  const out = new Map<string, number>();
  for (const [day, ids] of byDay) for (const [id, n] of await studentService.countStudentsBySection(ctx, ids, day, db)) out.set(id, n);
  return out;
}

export function toSectionRef(facts: SectionFacts, strength: number): SectionRefDTO {
  return {
    sectionOfferingId: facts.section._id,
    classOfferingId: facts.klass._id,
    academicSessionId: facts.session._id,
    locationId: facts.section.locationId,
    className: facts.klass.displayName,
    sectionCode: facts.section.sectionCode,
    label: facts.label,
    strength,
  };
}

/** The rule for new assignments: a closed or archived session is history. */
export function assertSessionWritable(session: Pick<AcademicSessionDoc, 'status'>) {
  if (session.status === 'CLOSED' || session.status === 'ARCHIVED') throw new AppError('SESSION_READ_ONLY');
}
